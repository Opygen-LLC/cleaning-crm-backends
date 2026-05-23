import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { JobStatus, BookingStatus } from "../../generated/prisma/enums";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";
import {
    IJobCreate,
    IJobUpdate,
    IAssignJobStaff,
    IStaffAvailabilityQuery,
} from "./job.interface";
import { jobSearchableFields, jobFilterableFields } from "./job.constant";
import { IRequestUser } from "../../types/requestUser.interface";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { FRONTEND_URL } from "../../config/ENV";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generates a unique job reference: #OP-JB-0001
 */
const generateJobRef = async (): Promise<string> => {
    const last = await prisma.job.findFirst({
        orderBy: { createdAt: "desc" },
        select: { jobRef: true },
    });

    let next = 1;
    if (last?.jobRef) {
        const parts = last.jobRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) next = num + 1;
    }

    return `#OP-JB-${next.toString().padStart(4, "0")}`;
};

/**
 * Resolve adminProfile.id from the authenticated user id.
 * Throws 404 when not found.
 */
const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

// ─── Standard includes shared across queries ──────────────────────────────────

const jobInclude = {
    client: {
        select: { id: true, name: true, email: true, phone: true },
    },
    staffAssignments: {
        include: {
            staff: {
                include: {
                    user: { select: { id: true, name: true, email: true } },
                },
            },
        },
    },
    booking: { select: { id: true, bookingRef: true, status: true } },
} as const;

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createJob = async (payload: IJobCreate, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    // Verify client belongs to this admin
    const client = await prisma.client.findFirst({
        where: { id: payload.clientId, adminId },
    });
    if (!client) throw new AppError(status.NOT_FOUND, "Client not found");

    // Verify quote belongs to this admin (if provided)
    if (payload.quoteId) {
        const quote = await prisma.quote.findFirst({
            where: { id: payload.quoteId, adminId },
        });
        if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");
    }

    // Verify estimate belongs to this admin (if provided)
    if (payload.estimateId) {
        const estimate = await prisma.estimate.findFirst({
            where: { id: payload.estimateId, adminId },
        });
        if (!estimate) throw new AppError(status.NOT_FOUND, "Estimate not found");
    }

    // Verify booking belongs to this admin and is not already linked (if provided)
    if (payload.bookingId) {
        const booking = await prisma.booking.findFirst({
            where: { id: payload.bookingId, adminId },
            include: { job: { select: { id: true } } },
        });
        if (!booking) throw new AppError(status.NOT_FOUND, "Booking not found");
        if (booking.job) {
            throw new AppError(
                status.CONFLICT,
                "This booking already has an associated job",
            );
        }
    }

    // Verify staff IDs belong to this admin (if provided)
    if (payload.staffIds?.length) {
        const staffCount = await prisma.staffProfile.count({
            where: { id: { in: payload.staffIds }, adminId },
        });
        if (staffCount !== payload.staffIds.length) {
            throw new AppError(
                status.BAD_REQUEST,
                "One or more staff members not found",
            );
        }
    }

    const jobRef = await generateJobRef();

    return prisma.job.create({
        data: {
            jobRef,
            adminId,
            clientId:      payload.clientId,
            serviceType:   payload.serviceType,
            address:       payload.address,
            scheduledDate: new Date(payload.scheduledDate),
            durationMins:  payload.durationMins,
            notes:         payload.notes,
            quoteId:       payload.quoteId,
            estimateId:    payload.estimateId,
            bookingId:     payload.bookingId,
            ...(payload.staffIds?.length && {
                staffAssignments: {
                    createMany: {
                        data: payload.staffIds.map((staffId) => ({ staffId })),
                    },
                },
            }),
        },
        include: jobInclude,
    });
};

const getAllJobs = async (queryParams: IQueryParams, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    return new QueryBuilder(prisma.job, queryParams, {
        searchableFields: jobSearchableFields,
        filterableFields: jobFilterableFields,
    })
        .where({ adminId })
        .search()
        .filter()
        .sort()
        .paginate()
        .include(jobInclude)
        .execute();
};

const getJobById = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const job = await prisma.job.findFirst({
        where: { id, adminId },
        include: jobInclude,
    });

    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    return job;
};

const updateJob = async (
    id: string,
    payload: IJobUpdate,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.job.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Job not found");

    if (
        existing.status === JobStatus.COMPLETED ||
        existing.status === JobStatus.CANCELLED
    ) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot edit a job with status ${existing.status}`,
        );
    }

    const data: Record<string, unknown> = { ...payload };
    if (payload.scheduledDate) {
        data.scheduledDate = new Date(payload.scheduledDate);
    }

    return prisma.job.update({
        where: { id },
        data,
        include: jobInclude,
    });
};

const updateJobStatus = async (
    id: string,
    newStatus: JobStatus,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.job.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Job not found");

    // Guard illegal status transitions
    const allowed: Record<JobStatus, JobStatus[]> = {
        [JobStatus.SCHEDULED]:   [JobStatus.IN_PROGRESS, JobStatus.CANCELLED],
        [JobStatus.IN_PROGRESS]: [JobStatus.COMPLETED,   JobStatus.CANCELLED],
        [JobStatus.COMPLETED]:   [],
        [JobStatus.CANCELLED]:   [],
    };

    if (!allowed[existing.status].includes(newStatus)) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot transition from ${existing.status} to ${newStatus}`,
        );
    }

    // When a job completes, mirror the status on its linked booking
    return prisma.$transaction(async (tx) => {
        const job = await tx.job.update({
            where: { id },
            data: { status: newStatus },
            include: jobInclude,
        });

        if (job.bookingId && newStatus === JobStatus.COMPLETED) {
            await tx.booking.update({
                where: { id: job.bookingId },
                data: { status: BookingStatus.COMPLETED },
            });
        }

        // Auto-generate a review token when the job is marked COMPLETED
        if (newStatus === JobStatus.COMPLETED) {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7);
            await tx.reviewToken.upsert({
                where: { jobId: id },
                create: { jobId: id, adminId: job.adminId, expiresAt },
                update: {}, // already exists — no-op
            });
        }

        // ── Auto-create a draft invoice when job is COMPLETED ─────────────────
        // Creates exactly one invoice per booking — skips silently if one
        // already exists, or if the job is not linked to a booking.
        if (newStatus === JobStatus.COMPLETED && job.bookingId) {
            const existingInvoice = await tx.invoice.findUnique({
                where: { bookingId: job.bookingId },
            });

            if (!existingInvoice) {
                const booking = await tx.booking.findUnique({
                    where: { id: job.bookingId },
                    include: {
                        client: { select: { name: true, email: true } },
                    },
                });

                if (booking) {
                    // Mirror the same ref pattern as invoice.service.ts
                    const lastInvoice = await tx.invoice.findFirst({
                        orderBy: { createdAt: "desc" },
                        select: { invoiceRef: true },
                    });
                    let nextNum = 1;
                    if (lastInvoice?.invoiceRef) {
                        const parts = lastInvoice.invoiceRef.split("-");
                        const n = parseInt(parts[parts.length - 1]);
                        if (!isNaN(n)) nextNum = n + 1;
                    }
                    const invoiceRef = `#OP-INV-${nextNum.toString().padStart(4, "0")}`;

                    const issuedDate = new Date();
                    const dueDate    = new Date();
                    dueDate.setDate(dueDate.getDate() + 14); // Net-14 terms

                    const lineTotal  = Number(booking.total);

                    await tx.invoice.create({
                        data: {
                            invoiceRef,
                            adminId:          job.adminId,
                            bookingId:        job.bookingId,
                            status:           "DRAFT",
                            clientName:       booking.client.name,
                            clientEmail:      booking.client.email,
                            serviceAddress:   booking.address,
                            linkedBookingRef: booking.bookingRef,
                            lineItems: [
                                {
                                    description: `${booking.serviceType.replace(/_/g, " ")} — ${booking.address}`,
                                    quantity:    1,
                                    unitPrice:   lineTotal,
                                    total:       lineTotal,
                                },
                            ],
                            issuedDate,
                            dueDate,
                            subtotal:   lineTotal,
                            taxRate:    0,
                            taxAmount:  0,
                            total:      lineTotal,
                        },
                    });
                }
            }
        }

        if (job.bookingId && newStatus === JobStatus.CANCELLED) {
            await tx.booking.update({
                where: { id: job.bookingId },
                data: { status: BookingStatus.CANCELLED },
            });
        }

        return job;
    }).then(async (completedJob) => {
        // ── Send review-request email after the transaction commits ──────────
        // Runs outside the transaction so a mail failure never rolls back the DB.
        if (newStatus === JobStatus.COMPLETED && completedJob) {
            try {
                const reviewToken = await prisma.reviewToken.findUnique({
                    where: { jobId: id },
                    select: { token: true },
                });

                if (reviewToken) {
                    const clientRecord = await prisma.client.findUnique({
                        where: { id: completedJob.clientId },
                        select: { name: true, email: true },
                    });

                    if (clientRecord) {
                        const staffNames = completedJob.staffAssignments.map(
                            (a: any) => a.staff.user.name,
                        );

                        await sendEmailSafely({
                            to:           clientRecord.email,
                            subject:      `How did we do? — ${completedJob.jobRef}`,
                            templateName: "review-request",
                            templateData: {
                                clientName:    clientRecord.name,
                                jobRef:        completedJob.jobRef,
                                serviceType:   completedJob.serviceType.replace(/_/g, " "),
                                completedDate: new Date(completedJob.scheduledDate).toLocaleDateString("en-GB", {
                                    weekday: "long",
                                    day:     "numeric",
                                    month:   "long",
                                    year:    "numeric",
                                }),
                                staffNames,
                                reviewUrl: `${FRONTEND_URL}/review/${reviewToken.token}`,
                            },
                        });
                    }
                }
            } catch (err) {
                // Non-fatal — log and continue
                console.error("[REVIEW EMAIL] Failed to send review request:", err);
            }
        }
        return completedJob;
    });
};

const deleteJob = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.job.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Job not found");

    if (existing.status === JobStatus.IN_PROGRESS) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cannot delete a job that is in progress",
        );
    }

    return prisma.job.delete({ where: { id } });
};

// ─── Convert booking → job ────────────────────────────────────────────────────

/**
 * Creates a Job from an existing Booking, copying all fields across.
 * The booking must belong to this admin and must not already have a job.
 */
const convertBookingToJob = async (
    bookingId: string,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const booking = await prisma.booking.findFirst({
        where: { id: bookingId, adminId },
        include: {
            job: { select: { id: true } },
            staffAssignments: { select: { staffId: true } },
        },
    });

    if (!booking) throw new AppError(status.NOT_FOUND, "Booking not found");

    if (booking.job) {
        throw new AppError(
            status.CONFLICT,
            "This booking already has an associated job",
        );
    }

    if (booking.status === BookingStatus.CANCELLED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cannot convert a cancelled booking to a job",
        );
    }

    const jobRef = await generateJobRef();

    return prisma.job.create({
        data: {
            jobRef,
            adminId,
            clientId:      booking.clientId,
            serviceType:   booking.serviceType,
            address:       booking.address,
            scheduledDate: booking.scheduledDate,
            durationMins:  booking.durationMins,
            notes:         booking.notes ?? undefined,
            quoteId:       booking.quoteId ?? undefined,
            bookingId:     booking.id,
            // Copy staff from booking
            ...(booking.staffAssignments.length && {
                staffAssignments: {
                    createMany: {
                        data: booking.staffAssignments.map(({ staffId }) => ({
                            staffId,
                        })),
                    },
                },
            }),
        },
        include: jobInclude,
    });
};

// ─── Staff Assignment ─────────────────────────────────────────────────────────

/**
 * Replaces the full staff assignment list for a job.
 * Passing an empty staffIds array removes all assignments.
 */
const assignStaff = async (
    jobId: string,
    payload: IAssignJobStaff,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    if (job.status === JobStatus.COMPLETED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cannot reassign staff on a completed job",
        );
    }

    // Verify all staff belong to this admin
    if (payload.staffIds.length) {
        const staffCount = await prisma.staffProfile.count({
            where: { id: { in: payload.staffIds }, adminId },
        });
        if (staffCount !== payload.staffIds.length) {
            throw new AppError(
                status.BAD_REQUEST,
                "One or more staff members not found",
            );
        }
    }

    return prisma.$transaction(async (tx) => {
        // Delete all existing assignments
        await tx.jobStaffAssignment.deleteMany({ where: { jobId } });

        // Create new set
        if (payload.staffIds.length) {
            await tx.jobStaffAssignment.createMany({
                data: payload.staffIds.map((staffId) => ({ jobId, staffId })),
            });
        }

        return tx.job.findUnique({
            where: { id: jobId },
            include: jobInclude,
        });
    }).then(async (updatedJob) => {
        // ── Dispatch notification email to each newly assigned staff member ──
        // Runs after the transaction so a mail failure never rolls back the DB.
        if (payload.staffIds.length && updatedJob) {
            const staffList = await prisma.staffProfile.findMany({
                where: { id: { in: payload.staffIds } },
                include: { user: { select: { name: true, email: true } } },
            });

            const client = await prisma.client.findUnique({
                where: { id: updatedJob.clientId },
                select: { name: true },
            });

            const jobDetailUrl = `${FRONTEND_URL}/admin/jobs/${jobId}`;

            await Promise.all(
                staffList.map((staff) =>
                    sendEmailSafely({
                        to:           staff.user.email,
                        subject:      `You've been assigned to job ${updatedJob.jobRef}`,
                        templateName: "staff-job-dispatch",
                        templateData: {
                            staffName:    staff.user.name,
                            jobRef:       updatedJob.jobRef,
                            clientName:   client?.name ?? "Client",
                            serviceType:  updatedJob.serviceType.replace(/_/g, " "),
                            address:      updatedJob.address,
                            scheduledDate: new Date(updatedJob.scheduledDate).toLocaleDateString("en-GB", {
                                weekday: "long",
                                day:     "numeric",
                                month:   "long",
                                year:    "numeric",
                            }),
                            scheduledTime: new Date(updatedJob.scheduledDate).toLocaleTimeString("en-GB", {
                                hour:   "2-digit",
                                minute: "2-digit",
                            }),
                            durationMins: updatedJob.durationMins,
                            jobDetailUrl,
                        },
                    }),
                ),
            );
        }
        return updatedJob;
    });
};

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * Returns job counts grouped by status for the admin's dashboard stats bar.
 */
const getJobStats = async (user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const [total, scheduled, inProgress, completed, cancelled] =
        await Promise.all([
            prisma.job.count({ where: { adminId } }),
            prisma.job.count({ where: { adminId, status: JobStatus.SCHEDULED } }),
            prisma.job.count({ where: { adminId, status: JobStatus.IN_PROGRESS } }),
            prisma.job.count({ where: { adminId, status: JobStatus.COMPLETED } }),
            prisma.job.count({ where: { adminId, status: JobStatus.CANCELLED } }),
        ]);

    return { total, scheduled, inProgress, completed, cancelled };
};

// ─── Staff Availability ───────────────────────────────────────────────────────

/**
 * For a given time window (date + durationMins), returns each staff member
 * with a flag indicating whether they have a conflicting job in that slot.
 */
const getStaffAvailability = async (
    query: IStaffAvailabilityQuery,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const windowStart = new Date(query.date);
    const windowEnd   = new Date(
        windowStart.getTime() + query.durationMins * 60_000,
    );

    // Fetch all active staff for this admin
    const allStaff = await prisma.staffProfile.findMany({
        where: { adminId },
        include: {
            user: { select: { id: true, name: true, email: true } },
        },
    });

    // Fetch all scheduled / in-progress jobs that overlap the window
    const overlappingJobs = await prisma.job.findMany({
        where: {
            adminId,
            status: { in: [JobStatus.SCHEDULED, JobStatus.IN_PROGRESS] },
            // Job starts before window ends AND job ends after window starts
            scheduledDate: { lt: windowEnd },
            AND: [
                {
                    scheduledDate: {
                        gte: new Date(
                            windowStart.getTime() -
                                // subtract max possible duration (rough upper bound)
                                24 * 60 * 60_000,
                        ),
                    },
                },
            ],
        },
        include: {
            staffAssignments: { select: { staffId: true } },
            client: { select: { name: true } },
        },
    });

    // Filter to genuinely overlapping jobs (computed via durationMins)
    const trueOverlaps = overlappingJobs.filter((job) => {
        const jobStart = job.scheduledDate.getTime();
        const jobEnd   = jobStart + job.durationMins * 60_000;
        return jobStart < windowEnd.getTime() && jobEnd > windowStart.getTime();
    });

    // Build a map: staffId → conflicting jobs
    const conflictMap = new Map<string, typeof trueOverlaps>();
    for (const job of trueOverlaps) {
        for (const { staffId } of job.staffAssignments) {
            if (!conflictMap.has(staffId)) conflictMap.set(staffId, []);
            conflictMap.get(staffId)!.push(job);
        }
    }

    const availability = allStaff.map((staff) => {
        const conflicts = conflictMap.get(staff.id) ?? [];
        return {
            staffId:   staff.id,
            name:      staff.user.name,
            email:     staff.user.email,
            available: conflicts.length === 0,
            conflictingJobs: conflicts.map((j) => ({
                jobId:         j.id,
                jobRef:        j.jobRef,
                clientName:    j.client.name,
                scheduledDate: j.scheduledDate,
                durationMins:  j.durationMins,
            })),
        };
    });

    return {
        windowStart,
        windowEnd,
        durationMins: query.durationMins,
        staff: availability,
    };
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const jobService = {
    createJob,
    getAllJobs,
    getJobById,
    updateJob,
    updateJobStatus,
    deleteJob,
    convertBookingToJob,
    assignStaff,
    getJobStats,
    getStaffAvailability,
};
