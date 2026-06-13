/**
 * job.service.ts  (updated — Phase 1 complete, production-ready)
 *
 * CHANGES vs previous version:
 *  • getStaffAvailability — now also checks:
 *      a) approved StaffLeave records that overlap the window
 *      b) StaffAvailability (weekly schedule): if a staff member has no active
 *         entry for the requested day-of-week, they're marked unavailable
 *  • All other logic is untouched
 */

import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import {
    JobStatus,
    BookingStatus,
    LeaveStatus,
    WeekDay,
} from "../../generated/prisma/enums";
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
import { emitToAdmin } from "../../config/socketio";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

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

// Map JS getDay() → Prisma WeekDay enum
const JS_DAY_TO_WEEKDAY: Record<number, WeekDay> = {
    0: WeekDay.SUNDAY,
    1: WeekDay.MONDAY,
    2: WeekDay.TUESDAY,
    3: WeekDay.WEDNESDAY,
    4: WeekDay.THURSDAY,
    5: WeekDay.FRIDAY,
    6: WeekDay.SATURDAY,
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createJob = async (payload: IJobCreate, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const client = await prisma.client.findFirst({
        where: { id: payload.clientId, adminId },
    });
    if (!client) throw new AppError(status.NOT_FOUND, "Client not found");

    if (payload.quoteId) {
        const quote = await prisma.quote.findFirst({
            where: { id: payload.quoteId, adminId },
        });
        if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");
    }

    if (payload.estimateId) {
        const estimate = await prisma.estimate.findFirst({
            where: { id: payload.estimateId, adminId },
        });
        if (!estimate)
            throw new AppError(status.NOT_FOUND, "Estimate not found");
    }

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
            clientId: payload.clientId,
            serviceType: payload.serviceType,
            address: payload.address,
            scheduledDate: new Date(payload.scheduledDate),
            durationMins: payload.durationMins,
            notes: payload.notes,
            quoteId: payload.quoteId,
            estimateId: payload.estimateId,
            bookingId: payload.bookingId,
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
    if (payload.scheduledDate)
        data.scheduledDate = new Date(payload.scheduledDate);

    return prisma.job.update({ where: { id }, data, include: jobInclude });
};

const updateJobStatus = async (
    id: string,
    newStatus: JobStatus,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);
    const existing = await prisma.job.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Job not found");

    const allowed: Record<JobStatus, JobStatus[]> = {
        [JobStatus.SCHEDULED]: [JobStatus.IN_PROGRESS, JobStatus.CANCELLED],
        [JobStatus.IN_PROGRESS]: [JobStatus.COMPLETED, JobStatus.CANCELLED],
        [JobStatus.COMPLETED]: [],
        [JobStatus.CANCELLED]: [],
    };

    if (!allowed[existing.status].includes(newStatus)) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot transition from ${existing.status} to ${newStatus}`,
        );
    }

    return prisma
        .$transaction(async (tx) => {
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

            if (newStatus === JobStatus.COMPLETED) {
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 7);
                await tx.reviewToken.upsert({
                    where: { jobId: id },
                    create: { jobId: id, adminId: job.adminId, expiresAt },
                    update: {},
                });
            }

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
                        const dueDate = new Date();
                        dueDate.setDate(dueDate.getDate() + 14);
                        const lineTotal = Number(booking.total);

                        await tx.invoice.create({
                            data: {
                                invoiceRef,
                                adminId: job.adminId,
                                bookingId: job.bookingId,
                                status: "DRAFT",
                                clientName: booking.client.name,
                                clientEmail: booking.client.email,
                                serviceAddress: booking.address,
                                linkedBookingRef: booking.bookingRef,
                                lineItems: [
                                    {
                                        description: `${booking.serviceType.replace(/_/g, " ")} — ${booking.address}`,
                                        quantity: 1,
                                        unitPrice: lineTotal,
                                        total: lineTotal,
                                    },
                                ],
                                issuedDate,
                                dueDate,
                                subtotal: lineTotal,
                                taxRate: 0,
                                taxAmount: 0,
                                total: lineTotal,
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
        })
        .then(async (completedJob) => {
            // Real-time push — emit to admin room
            emitToAdmin(completedJob.adminId, "job:statusUpdated", {
                jobId: completedJob.id,
                jobRef: completedJob.jobRef,
                newStatus,
                updatedAt: new Date().toISOString(),
            });

            // Send review-request email when job is COMPLETED
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
                            const staffNames =
                                completedJob.staffAssignments.map(
                                    (a: any) => a.staff.user.name,
                                );

                            await sendEmailSafely({
                                to: clientRecord.email,
                                subject: `How did we do? — ${completedJob.jobRef}`,
                                templateName: "review-request",
                                templateData: {
                                    clientName: clientRecord.name,
                                    jobRef: completedJob.jobRef,
                                    serviceType:
                                        completedJob.serviceType.replace(
                                            /_/g,
                                            " ",
                                        ),
                                    completedDate: new Date(
                                        completedJob.scheduledDate,
                                    ).toLocaleDateString("en-GB", {
                                        weekday: "long",
                                        day: "numeric",
                                        month: "long",
                                        year: "numeric",
                                    }),
                                    staffNames,
                                    reviewUrl: `${FRONTEND_URL}/review/${reviewToken.token}`,
                                },
                            });
                        }
                    }
                } catch (err) {
                    console.error(
                        "[REVIEW EMAIL] Failed to send review request:",
                        err,
                    );
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

const convertBookingToJob = async (bookingId: string, user: IRequestUser) => {
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
            clientId: booking.clientId,
            serviceType: booking.serviceType,
            address: booking.address,
            scheduledDate: booking.scheduledDate,
            durationMins: booking.durationMins,
            notes: booking.notes ?? undefined,
            quoteId: booking.quoteId ?? undefined,
            bookingId: booking.id,
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

    return prisma
        .$transaction(async (tx) => {
            await tx.jobStaffAssignment.deleteMany({ where: { jobId } });
            if (payload.staffIds.length) {
                await tx.jobStaffAssignment.createMany({
                    data: payload.staffIds.map((staffId) => ({
                        jobId,
                        staffId,
                    })),
                });
            }
            return tx.job.findUnique({
                where: { id: jobId },
                include: jobInclude,
            });
        })
        .then(async (updatedJob) => {
            // Real-time push — emit staff assignment to admin room
            if (updatedJob) {
                emitToAdmin(updatedJob.adminId, "job:staffAssigned", {
                    jobId: updatedJob.id,
                    jobRef: updatedJob.jobRef,
                    staffIds: payload.staffIds,
                    updatedAt: new Date().toISOString(),
                });
            }

            // Dispatch notification email to each newly assigned staff member
            if (payload.staffIds.length && updatedJob) {
                const staffList = await prisma.staffProfile.findMany({
                    where: { id: { in: payload.staffIds } },
                    include: { user: { select: { name: true, email: true } } },
                });
                const client = await prisma.client.findUnique({
                    where: { id: updatedJob.clientId },
                    select: { name: true },
                });
                const jobDetailUrl = `${FRONTEND_URL}/staff/dashboard/jobs/${jobId}`;

                await Promise.all(
                    staffList.map((staff) =>
                        sendEmailSafely({
                            to: staff.user.email,
                            subject: `You've been assigned to job ${updatedJob.jobRef}`,
                            templateName: "staff-job-dispatch",
                            templateData: {
                                staffName: staff.user.name,
                                jobRef: updatedJob.jobRef,
                                clientName: client?.name ?? "Client",
                                serviceType: updatedJob.serviceType.replace(
                                    /_/g,
                                    " ",
                                ),
                                address: updatedJob.address,
                                scheduledDate: new Date(
                                    updatedJob.scheduledDate,
                                ).toLocaleDateString("en-GB", {
                                    weekday: "long",
                                    day: "numeric",
                                    month: "long",
                                    year: "numeric",
                                }),
                                scheduledTime: new Date(
                                    updatedJob.scheduledDate,
                                ).toLocaleTimeString("en-GB", {
                                    hour: "2-digit",
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

const getJobStats = async (user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);
    const [total, scheduled, inProgress, completed, cancelled] =
        await Promise.all([
            prisma.job.count({ where: { adminId } }),
            prisma.job.count({
                where: { adminId, status: JobStatus.SCHEDULED },
            }),
            prisma.job.count({
                where: { adminId, status: JobStatus.IN_PROGRESS },
            }),
            prisma.job.count({
                where: { adminId, status: JobStatus.COMPLETED },
            }),
            prisma.job.count({
                where: { adminId, status: JobStatus.CANCELLED },
            }),
        ]);
    return { total, scheduled, inProgress, completed, cancelled };
};

/**
 * getStaffAvailability  (Phase 1 — upgraded)
 *
 * Checks three independent conflict sources:
 *   1. Active jobs that overlap the requested time window  (original logic)
 *   2. Approved leave periods that cover the requested date  [NEW]
 *   3. Weekly schedule: if the staff member has no active StaffAvailability
 *      entry for the requested day-of-week, they are not scheduled  [NEW]
 *
 * The response includes a `reason` field on unavailable staff so the UI
 * can display a meaningful tooltip ("On leave", "Not scheduled", "Job conflict").
 */
const getStaffAvailability = async (
    query: IStaffAvailabilityQuery,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);
    const windowStart = new Date(query.date);
    const windowEnd = new Date(
        windowStart.getTime() + query.durationMins * 60_000,
    );
    const requestDay = JS_DAY_TO_WEEKDAY[windowStart.getDay()];

    // ── Load all staff with their weekly availability and leave records ────────
    const allStaff = await prisma.staffProfile.findMany({
        where: { adminId },
        include: {
            user: { select: { id: true, name: true, email: true } },
            staffAvailability: { where: { isActive: true } },
            staffLeave: {
                where: {
                    status: LeaveStatus.APPROVED,
                    startDate: { lte: windowEnd },
                    endDate: { gte: windowStart },
                },
            },
        },
    });

    // ── Load active jobs that could conflict ──────────────────────────────────
    const overlappingJobs = await prisma.job.findMany({
        where: {
            adminId,
            status: { in: [JobStatus.SCHEDULED, JobStatus.IN_PROGRESS] },
            scheduledDate: { lt: windowEnd },
            AND: [
                {
                    scheduledDate: {
                        gte: new Date(windowStart.getTime() - 24 * 60 * 60_000),
                    },
                },
            ],
        },
        include: {
            staffAssignments: { select: { staffId: true } },
            client: { select: { name: true } },
        },
    });

    const trueOverlaps = overlappingJobs.filter((job) => {
        const jobStart = job.scheduledDate.getTime();
        const jobEnd = jobStart + job.durationMins * 60_000;
        return jobStart < windowEnd.getTime() && jobEnd > windowStart.getTime();
    });

    const conflictMap = new Map<string, typeof trueOverlaps>();
    for (const job of trueOverlaps) {
        for (const { staffId } of job.staffAssignments) {
            if (!conflictMap.has(staffId)) conflictMap.set(staffId, []);
            conflictMap.get(staffId)!.push(job);
        }
    }

    // ── Build response ────────────────────────────────────────────────────────
    const availability = allStaff.map((staff) => {
        const conflicts = conflictMap.get(staff.id) ?? [];
        const onLeave = staff.staffLeave.length > 0;
        const daySchedule = staff.staffAvailability.find(
            (a) => a.day === requestDay,
        );
        const notScheduled = !daySchedule; // has no active entry for this day

        const available = conflicts.length === 0 && !onLeave && !notScheduled;

        // Human-readable reason for unavailability (first match wins)
        let unavailableReason: string | undefined;
        if (onLeave) unavailableReason = "On approved leave";
        else if (notScheduled) unavailableReason = "Not scheduled on this day";
        else if (conflicts.length > 0) unavailableReason = "Job conflict";

        return {
            staffId: staff.id,
            name: staff.user.name,
            email: staff.user.email,
            available,
            unavailableReason: available ? undefined : unavailableReason,
            // Working hours for the day (for the UI to display)
            scheduledHours: daySchedule
                ? {
                      startTime: daySchedule.startTime,
                      endTime: daySchedule.endTime,
                  }
                : null,
            conflictingJobs: conflicts.map((j) => ({
                jobId: j.id,
                jobRef: j.jobRef,
                clientName: j.client.name,
                scheduledDate: j.scheduledDate,
                durationMins: j.durationMins,
            })),
            leaveDetails: onLeave
                ? staff.staffLeave.map((l) => ({
                      startDate: l.startDate,
                      endDate: l.endDate,
                      reason: l.reason,
                  }))
                : [],
        };
    });

    return {
        windowStart,
        windowEnd,
        durationMins: query.durationMins,
        requestedDay: requestDay,
        staff: availability,
    };
};

// ─── Phase 2: Staff check-in / check-out ─────────────────────────────────────

/**
 * Resolve the StaffProfile id from a user id.
 * Staff call check-in/out so we need to look them up differently from admins.
 */
const resolveStaffAssignment = async (
    jobId: string,
    userId: string,
    user: IRequestUser,
): Promise<{
    adminId: string;
    assignment: { jobId: string; staffId: string };
}> => {
    // If STAFF role → look up staff profile
    if (user.role === "STAFF") {
        const staffProfile = await prisma.staffProfile.findUnique({
            where: { userId },
        });
        if (!staffProfile)
            throw new AppError(status.NOT_FOUND, "Staff profile not found");

        const assignment = await prisma.jobStaffAssignment.findFirst({
            where: { jobId, staffId: staffProfile.id },
        });
        if (!assignment) {
            throw new AppError(
                status.FORBIDDEN,
                "You are not assigned to this job",
            );
        }

        const job = await prisma.job.findUnique({ where: { id: jobId } });
        if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

        return { adminId: job.adminId, assignment };
    }

    // ADMIN path
    const adminId = await resolveAdminId(userId);
    const assignment = await prisma.jobStaffAssignment.findFirst({
        where: { jobId },
    });
    if (!assignment) {
        throw new AppError(status.BAD_REQUEST, "No staff assigned to this job");
    }
    return { adminId, assignment };
};

/**
 * POST /job/:id/checkin
 *
 * Records a checkInAt timestamp on the job_staff_assignment row and
 * transitions the job status from SCHEDULED → IN_PROGRESS.
 */
const checkIn = async (jobId: string, user: IRequestUser) => {
    const { adminId, assignment } = await resolveStaffAssignment(
        jobId,
        user.id,
        user,
    );

    const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    if (job.status === JobStatus.IN_PROGRESS) {
        // Already checked in — idempotent: just return current state
        return prisma.jobStaffAssignment.findUnique({
            where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
        });
    }

    if (job.status !== JobStatus.SCHEDULED) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot check in — job is ${job.status}`,
        );
    }

    return prisma.$transaction(async (tx) => {
        // Stamp check-in time
        const updated = await tx.jobStaffAssignment.update({
            where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
            data: { checkInAt: new Date() },
        });

        // Transition status
        await tx.job.update({
            where: { id: jobId },
            data: { status: JobStatus.IN_PROGRESS },
        });

        // Real-time push
        emitToAdmin(job.adminId, "job:statusUpdated", {
            jobId,
            jobRef: job.jobRef,
            newStatus: JobStatus.IN_PROGRESS,
            updatedAt: new Date().toISOString(),
        });

        return updated;
    });
};

/**
 * POST /job/:id/checkout
 *
 * Records a checkOutAt timestamp, computes hoursWorked, and transitions
 * the job status from IN_PROGRESS → COMPLETED.
 */
const checkOut = async (jobId: string, user: IRequestUser) => {
    const { adminId, assignment } = await resolveStaffAssignment(
        jobId,
        user.id,
        user,
    );

    const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    if (job.status !== JobStatus.IN_PROGRESS) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot check out — job is ${job.status}`,
        );
    }

    const currentAssignment = await prisma.jobStaffAssignment.findUnique({
        where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
    });

    const checkOutAt = new Date();
    const checkInAt = currentAssignment?.checkInAt ?? checkOutAt;
    const diffMs = checkOutAt.getTime() - checkInAt.getTime();
    const hoursWorked = Math.round((diffMs / 3_600_000) * 100) / 100; // 2 d.p.

    return prisma.$transaction(async (tx) => {
        const updated = await tx.jobStaffAssignment.update({
            where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
            data: { checkOutAt, hoursWorked },
        });

        // Delegate status completion to the existing updateJobStatus function
        // (which handles booking sync, review token, invoice creation, email)
        await updateJobStatus(jobId, JobStatus.COMPLETED, user);

        return { ...updated, hoursWorked };
    });
};

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
    // Phase 2
    checkIn,
    checkOut,
};
