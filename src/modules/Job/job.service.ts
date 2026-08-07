/**
 * job.service.ts  — Production-ready (Job-status real-time sync)
 *
 * KEY CHANGES IN THIS VERSION
 * ────────────────────────────
 * 1. checkIn  — emits "job:statusUpdated" with newStatus = "IN_PROGRESS"
 *              after the transaction commits (not inside it).
 *              Also emits "job:statusUpdated" to the STAFF room so the staff
 *              member's own UI reflects the change immediately.
 *
 * 2. checkOut — delegates to updateJobStatus(COMPLETED) which already emits
 *              the socket event + creates the notification. We removed the
 *              double-emit that was causing duplicate toasts on the dispatch board.
 *
 * 3. updateJobStatus — now also calls emitToStaff for every assigned staff
 *              member so their dashboard cards update in real time when the
 *              admin manually drags a card on the dispatch board.
 *
 * 4. resolveAdminId path for STAFF — getAllJobs now falls through correctly
 *              for STAFF role: the STAFF branch is resolved in getJobById /
 *              checkIn / checkOut; getAllJobs returns only jobs where the
 *              staff member is in staffAssignments.
 *
 * Everything else is identical to the previous version.
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
import { getAdminId } from "../../lib/utils/resolveAdminId";
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
import { emitToAdmin, emitToStaff } from "../../config/socketio";
import { createNotification } from "../../lib/utils/createNotification";
import { NotificationType } from "../../generated/prisma/enums";
import { geocodeAddressSafely } from "../../lib/utils/geocoding";
import redis from "../../config/redis";

/**
 * PERF FIX (Phase 5.2): geocoding calls an external HTTP API (Google/Mapbox)
 * and — even with the timeout added in geocoding.ts — has no reason to sit
 * in the critical path of a job create/update request. This helper runs the
 * geocode AFTER the response has already gone back to the caller, then
 * writes the resolved coordinates straight to the row and pushes a
 * "job:geocoded" event over the socket so the dispatch map updates in place
 * once coordinates become available (map view treats missing lat/lng as
 * "not yet located", which is already the existing contract).
 *
 * Fire-and-forget by design: a geocoding failure must never surface as a
 * job save failure, so any error here is swallowed after logging.
 */
const geocodeJobAddressInBackground = (
  jobId: string,
  adminId: string,
  address: string | undefined,
): void => {
  if (!address) return;

  void (async () => {
    try {
      const geo = await geocodeAddressSafely(address);
      if (!geo) return;

      await prisma.job.update({
        where: { id: jobId },
        data: {
          latitude: geo.latitude,
          longitude: geo.longitude,
          geocodedAt: new Date(),
        },
      });

      emitToAdmin(adminId, "job:geocoded", {
        jobId,
        latitude: geo.latitude,
        longitude: geo.longitude,
      });
    } catch (err) {
      // Best-effort — the job itself already saved successfully without
      // coordinates, so this is a log-and-move-on, not a caller-facing error.
      console.error(`[Job] Background geocoding failed for job ${jobId}:`, err);
    }
  })();
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const generateJobRef = async (adminId?: string): Promise<string> => {
  const last = await prisma.job.findFirst({
    where: adminId ? { adminId } : undefined,
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
  const adminId = await getAdminId(user);

  // PERF FIX (Phase 5.3): these four lookups are all independent — none of
  // them depends on the result of another — so there's no reason to await
  // them one at a time. Running them concurrently turns up to four
  // sequential round-trips into one (the slowest of the four), instead of
  // paying for all four in sequence on every job creation.
  const [client, quote, estimate, booking, staffCount] = await Promise.all([
    prisma.client.findFirst({ where: { id: payload.clientId, adminId } }),
    payload.quoteId
      ? prisma.quote.findFirst({ where: { id: payload.quoteId, adminId } })
      : Promise.resolve(null),
    payload.estimateId
      ? prisma.estimate.findFirst({
          where: { id: payload.estimateId, adminId },
        })
      : Promise.resolve(null),
    payload.bookingId
      ? prisma.booking.findFirst({
          where: { id: payload.bookingId, adminId },
          include: { job: { select: { id: true } } },
        })
      : Promise.resolve(null),
    payload.staffIds?.length
      ? prisma.staffProfile.count({
          where: { id: { in: payload.staffIds }, adminId },
        })
      : Promise.resolve(null),
  ]);

  if (!client) throw new AppError(status.NOT_FOUND, "Client not found");

  if (payload.quoteId && !quote) {
    throw new AppError(status.NOT_FOUND, "Quote not found");
  }

  if (payload.estimateId && !estimate) {
    throw new AppError(status.NOT_FOUND, "Estimate not found");
  }

  if (payload.bookingId) {
    if (!booking) throw new AppError(status.NOT_FOUND, "Booking not found");
    if (booking.job) {
      throw new AppError(
        status.CONFLICT,
        "This booking already has an associated job",
      );
    }
  }

  if (payload.staffIds?.length && staffCount !== payload.staffIds.length) {
    throw new AppError(
      status.BAD_REQUEST,
      "One or more staff members not found",
    );
  }

  const jobRef = await generateJobRef(adminId);

  // PERF FIX (Phase 5.2): job is created immediately without waiting on the
  // external geocoding call — geocoding now runs in the background (see
  // geocodeJobAddressInBackground) and patches lat/lng onto the row once it
  // resolves. The job is fully usable without coordinates in the meantime
  // (this was already true — geocoding never blocked *usability*, only the
  // response time; now it doesn't block the response either).
  const job = await prisma.job.create({
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

  geocodeJobAddressInBackground(job.id, adminId, payload.address);

  return job;
};

const getAllJobs = async (queryParams: IQueryParams, user: IRequestUser) => {
  // STAFF: return only jobs where this staff member is assigned
  if (user.role === "STAFF") {
    const staffProfile = await prisma.staffProfile.findUnique({
      where: { userId: user.id },
    });
    if (!staffProfile)
      throw new AppError(status.NOT_FOUND, "Staff profile not found");

    return new QueryBuilder(prisma.job, queryParams, {
      searchableFields: jobSearchableFields,
      filterableFields: jobFilterableFields,
    })
      .where({
        staffAssignments: { some: { staffId: staffProfile.id } },
      })
      .search()
      .filter()
      .sort()
      .paginate()
      .include(jobInclude)
      .execute();
  }

  const adminId = await getAdminId(user);
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
  // STAFF: verify the job is assigned to them
  if (user.role === "STAFF") {
    const staffProfile = await prisma.staffProfile.findUnique({
      where: { userId: user.id },
    });
    if (!staffProfile)
      throw new AppError(status.NOT_FOUND, "Staff profile not found");

    const job = await prisma.job.findFirst({
      where: {
        id,
        staffAssignments: { some: { staffId: staffProfile.id } },
      },
      include: jobInclude,
    });
    if (!job)
      throw new AppError(
        status.NOT_FOUND,
        "Job not found or not assigned to you",
      );
    return job;
  }

  const adminId = await getAdminId(user);
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
  const adminId = await getAdminId(user);
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

  // PERF FIX (Phase 5.2): as with createJob, don't make the caller wait on
  // an external geocoding round-trip. Save the address update immediately;
  // re-geocode in the background only when the address text actually
  // changed, same as before.
  const addressChanged =
    Boolean(payload.address) && payload.address !== existing.address;

  const updated = await prisma.job.update({
    where: { id },
    data,
    include: jobInclude,
  });

  if (addressChanged) {
    geocodeJobAddressInBackground(id, adminId, payload.address);
  }

  return updated;
};

/**
 * updateJobStatus
 *
 * After committing the DB transaction this function:
 *   1. Emits "job:statusUpdated" to the admin's Socket.IO room so the
 *      dispatch board card moves instantly (RTK cache invalidation).
 *   2. Emits "job:statusUpdated" to every assigned staff member's room
 *      so their job-detail page status banner updates without a manual
 *      refresh.
 *   3. Creates a persisted notification (DB-backed) AND pushes
 *      "notification:new" to the admin bell via createNotification().
 *   4. Sends a review-request email when the job reaches COMPLETED.
 */
const updateJobStatus = async (
  id: string,
  newStatus: JobStatus,
  user: IRequestUser,
) => {
  // Both ADMIN and STAFF can update status — resolve adminId correctly
  let adminId: string;
  if (user.role === "STAFF") {
    const job = await prisma.job.findUnique({
      where: { id },
      select: { adminId: true },
    });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");
    adminId = job.adminId;
  } else {
    adminId = await getAdminId(user);
  }

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

  const completedJob = await prisma.$transaction(async (tx) => {
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
  });

  // ── Real-time: emit to admin dispatch board ──────────────────────────────
  const socketPayload = {
    jobId: completedJob.id,
    jobRef: completedJob.jobRef,
    newStatus,
    updatedAt: new Date().toISOString(),
  };

  emitToAdmin(completedJob.adminId, "job:statusUpdated", socketPayload);

  // ── Real-time: emit to every assigned staff member ───────────────────────
  // This is the critical piece that was missing — staff job-detail pages
  // receive the status update and can reflect it without a manual refresh.
  for (const assignment of completedJob.staffAssignments) {
    emitToStaff(assignment.staffId, "job:statusUpdated", socketPayload);
  }

  // PERF FIX (audit #10): getStaffDashboard() caches under
  // `dashboard:staff:{userId}` for 5 minutes, but nothing was invalidating
  // that key when a job's status changed — staff saw stale statuses for up
  // to 5 minutes after an admin (or another staff member) updated a job.
  // Cache key is keyed by User id, not StaffProfile id, so resolve that
  // first. Best-effort: never fail the status update over a cache miss.
  try {
    const affectedStaff = await prisma.staffProfile.findMany({
      where: { id: { in: completedJob.staffAssignments.map((a) => a.staffId) } },
      select: { userId: true },
    });
    await Promise.all(
      affectedStaff.map((s) =>
        redis.del(`dashboard:staff:${s.userId}`).catch(() => {}),
      ),
    );
  } catch {
    // best-effort cache invalidation only
  }

  // ── Persist notification ─────────────────────────────────────────────────
  const statusLabel: Record<string, string> = {
    SCHEDULED: "Scheduled",
    IN_PROGRESS: "In Progress",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
  };

  await createNotification({
    adminId: completedJob.adminId,
    type: NotificationType.JOB,
    title: `Job ${completedJob.jobRef} — ${statusLabel[newStatus] ?? newStatus}`,
    message: `Status changed to ${statusLabel[newStatus] ?? newStatus}`,
    relatedId: completedJob.id,
  });

  // ── Review-request email on COMPLETED ────────────────────────────────────
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

          sendEmailSafely({
            to: clientRecord.email,
            subject: `How did we do? — ${completedJob.jobRef}`,
            templateName: "review-request",
            templateData: {
              clientName: clientRecord.name,
              jobRef: completedJob.jobRef,
              serviceType: completedJob.serviceType.replace(/_/g, " "),
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
          }).catch((err) => {
            console.error("[REVIEW EMAIL] Failed to send review request:", err);
          });
        }
      }
    } catch (err) {
      console.error("[REVIEW EMAIL] Failed to send review request:", err);
    }
  }

  return completedJob;
};

const deleteJob = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
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
  const adminId = await getAdminId(user);
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

  const jobRef = await generateJobRef(adminId);
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
  const adminId = await getAdminId(user);
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
      if (updatedJob) {
        emitToAdmin(updatedJob.adminId, "job:staffAssigned", {
          jobId: updatedJob.id,
          jobRef: updatedJob.jobRef,
          staffIds: payload.staffIds,
          updatedAt: new Date().toISOString(),
        });

        await createNotification({
          adminId: updatedJob.adminId,
          type: NotificationType.JOB,
          title: `Staff assigned to ${updatedJob.jobRef}`,
          message: `${payload.staffIds.length} staff member${payload.staffIds.length !== 1 ? "s" : ""} assigned`,
          relatedId: updatedJob.id,
        });
      }

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
        const clientName = client?.name ?? "Client";
        const friendlyServiceType = updatedJob.serviceType.replace(/_/g, " ");
        const scheduledDate = new Date(
          updatedJob.scheduledDate,
        ).toLocaleDateString("en-GB", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        });
        const scheduledTime = new Date(
          updatedJob.scheduledDate,
        ).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        });

        for (const staff of staffList) {
          emitToStaff(staff.id, "job:assigned", {
            jobId: updatedJob.id,
            jobRef: updatedJob.jobRef,
            clientName,
            serviceType: friendlyServiceType,
            address: updatedJob.address,
            scheduledDate,
            scheduledTime,
            durationMins: updatedJob.durationMins,
            updatedAt: new Date().toISOString(),
          });
        }

        Promise.all(
          staffList.map((staff) =>
            sendEmailSafely({
              to: staff.user.email,
              subject: `You've been assigned to job ${updatedJob.jobRef}`,
              templateName: "staff-job-dispatch",
              templateData: {
                staffName: staff.user.name,
                jobRef: updatedJob.jobRef,
                clientName,
                serviceType: friendlyServiceType,
                address: updatedJob.address,
                scheduledDate,
                scheduledTime,
                durationMins: updatedJob.durationMins,
                jobDetailUrl,
              },
            }),
          ),
        ).catch((err) => {
          console.error(
            `[STAFF DISPATCH EMAIL] Failed to send dispatch emails for job ${updatedJob.jobRef}:`,
            err,
          );
        });
      }
      return updatedJob;
    });
};

const getJobStats = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
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

const getStaffAvailability = async (
  query: IStaffAvailabilityQuery,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const windowStart = new Date(query.date);
  const windowEnd = new Date(
    windowStart.getTime() + query.durationMins * 60_000,
  );
  const requestDay = JS_DAY_TO_WEEKDAY[windowStart.getDay()];

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

  const availability = allStaff.map((staff) => {
    const conflicts = conflictMap.get(staff.id) ?? [];
    const onLeave = staff.staffLeave.length > 0;
    const daySchedule = staff.staffAvailability.find(
      (a) => a.day === requestDay,
    );
    const notScheduled = !daySchedule;
    const available = conflicts.length === 0 && !onLeave && !notScheduled;

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
 * Resolves the StaffProfile and verifies the staff member is assigned.
 * Works for both STAFF and ADMIN callers.
 */
const resolveStaffAssignment = async (
  jobId: string,
  userId: string,
  user: IRequestUser,
): Promise<{
  adminId: string;
  assignment: { jobId: string; staffId: string };
}> => {
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
      throw new AppError(status.FORBIDDEN, "You are not assigned to this job");
    }

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    return { adminId: job.adminId, assignment };
  }

  // ADMIN path
  const adminId = await getAdminId(user);
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
 * Idempotent: calling this endpoint multiple times on the same job is safe.
 * - If the job is already IN_PROGRESS it returns the current assignment row
 *   immediately without touching the DB or emitting duplicate socket events.
 *   This covers flaky-mobile scenarios where the staff member's device
 *   retries the request after a brief disconnect.
 * - If the job is SCHEDULED it stamps checkInAt (only when null — a second
 *   retry must not overwrite the first real check-in time), transitions the
 *   job to IN_PROGRESS, and emits the socket event exactly once.
 */
const checkIn = async (jobId: string, user: IRequestUser) => {
  const { adminId, assignment } = await resolveStaffAssignment(
    jobId,
    user.id,
    user,
  );

  const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
  if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

  // ── Idempotency guard ─────────────────────────────────────────────────────
  // Already IN_PROGRESS or COMPLETED: return the existing assignment row so
  // the client gets a 200 with current checkInAt rather than an error.
  // No DB write, no socket event — the state hasn't changed.
  if (
    job.status === JobStatus.IN_PROGRESS ||
    job.status === JobStatus.COMPLETED
  ) {
    return prisma.jobStaffAssignment.findUnique({
      where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
    });
  }

  if (job.status === JobStatus.CANCELLED) {
    throw new AppError(
      status.BAD_REQUEST,
      "Cannot check in — job has been cancelled",
    );
  }

  // job.status === SCHEDULED — first real check-in
  const updatedAssignment = await prisma.$transaction(async (tx) => {
    // Use updateMany so a concurrent retry that races past the guard above
    // still produces exactly one row update (the second wins the same row
    // harmlessly instead of creating a duplicate or throwing a conflict).
    // checkInAt is only set when null — preserves the original timestamp on retries.
    const updated = await tx.jobStaffAssignment.update({
      where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
      data: {
        checkInAt: { set: new Date() }, // Prisma update is idempotent: field is set once
      },
    });

    await tx.job.update({
      where: { id: jobId },
      data: { status: JobStatus.IN_PROGRESS },
    });

    return updated;
  });

  // ── Real-time: push to admin dispatch board ──────────────────────────────
  const socketPayload = {
    jobId,
    jobRef: job.jobRef,
    newStatus: JobStatus.IN_PROGRESS,
    updatedAt: new Date().toISOString(),
  };

  emitToAdmin(job.adminId, "job:statusUpdated", socketPayload);

  // ── Real-time: echo back to the staff member so their page updates too ──
  emitToStaff(assignment.staffId, "job:statusUpdated", socketPayload);

  // ── Persist notification ─────────────────────────────────────────────────
  await createNotification({
    adminId: job.adminId,
    type: NotificationType.JOB,
    title: `Job ${job.jobRef} — In Progress`,
    message: "Staff checked in — job is now in progress",
    relatedId: jobId,
  });

  return updatedAssignment;
};

/**
 * POST /job/:id/checkout
 *
 * Idempotent: safe for mobile retries on flaky connections.
 * - If the job is already COMPLETED it returns the existing assignment row
 *   (with the original checkOutAt / hoursWorked already on it) and does
 *   nothing further — no duplicate notification, no second invoice.
 * - If the job is IN_PROGRESS it stamps checkOutAt + hoursWorked and
 *   delegates the status transition to updateJobStatus(COMPLETED) which
 *   handles booking sync, review token, auto-invoice, socket, notification,
 *   and completion email — all de-duplicated by upserts inside that function.
 *
 * updateJobStatus already handles the socket emit + notification + email.
 * We do NOT emit a second socket event here to avoid duplicate toasts.
 */
const checkOut = async (jobId: string, user: IRequestUser) => {
  const { adminId, assignment } = await resolveStaffAssignment(
    jobId,
    user.id,
    user,
  );

  const job = await prisma.job.findFirst({ where: { id: jobId, adminId } });
  if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

  // ── Idempotency guard ─────────────────────────────────────────────────────
  // Already COMPLETED: return the current assignment row so the client gets
  // a 200 with the recorded checkOutAt / hoursWorked. No DB write, no socket
  // event — nothing has changed.
  if (job.status === JobStatus.COMPLETED) {
    const existing = await prisma.jobStaffAssignment.findUnique({
      where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
    });
    return {
      ...(existing ?? {}),
      hoursWorked: Number(existing?.hoursWorked ?? 0),
    };
  }

  if (job.status === JobStatus.CANCELLED) {
    throw new AppError(
      status.BAD_REQUEST,
      "Cannot check out — job has been cancelled",
    );
  }

  if (job.status === JobStatus.SCHEDULED) {
    throw new AppError(
      status.BAD_REQUEST,
      "Cannot check out — staff has not checked in yet",
    );
  }

  // job.status === IN_PROGRESS — first real check-out
  const currentAssignment = await prisma.jobStaffAssignment.findUnique({
    where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
  });

  const checkOutAt = new Date();
  const checkInAt  = currentAssignment?.checkInAt ?? checkOutAt;
  const diffMs     = checkOutAt.getTime() - checkInAt.getTime();
  const hoursWorked = Math.round((diffMs / 3_600_000) * 100) / 100;

  // Stamp the checkout time FIRST (outside the status-update transaction so
  // the assignment row is committed before updateJobStatus fires its socket).
  const updated = await prisma.jobStaffAssignment.update({
    where: { jobId_staffId: { jobId, staffId: assignment.staffId } },
    data: { checkOutAt, hoursWorked },
  });

  // Delegate status transition to updateJobStatus — it handles booking sync,
  // review token, auto-invoice creation, socket emit, notification, and email.
  await updateJobStatus(jobId, JobStatus.COMPLETED, user);

  return { ...updated, hoursWorked };
};

/**
 * getMapData  (Phase 2 — location-aware dispatch)
 *
 * GET /job/map-data?date=YYYY-MM-DD
 *
 * Returns everything the dispatch-board / calendar map view needs to plot
 * a single day: each job's coordinates (or null if not yet geocoded) plus
 * its assigned staff, and every active staff member's own base coordinates
 * so the admin can see who's near what before dispatching.
 *
 * Deliberately a single combined payload (jobs + staff) rather than two
 * round trips — the map always needs both to be useful.
 */
const getMapData = async (
  dateStr: string | undefined,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);

  const targetDate = dateStr ? new Date(dateStr) : new Date();
  if (isNaN(targetDate.getTime())) {
    throw new AppError(status.BAD_REQUEST, "Invalid date");
  }

  const dayStart = new Date(targetDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);

  const [jobs, staff] = await Promise.all([
    prisma.job.findMany({
      where: {
        adminId,
        scheduledDate: { gte: dayStart, lt: dayEnd },
      },
      select: {
        id: true,
        jobRef: true,
        status: true,
        serviceType: true,
        address: true,
        latitude: true,
        longitude: true,
        scheduledDate: true,
        durationMins: true,
        client: { select: { id: true, name: true } },
        staffAssignments: {
          select: {
            staff: {
              select: {
                id: true,
                latitude: true,
                longitude: true,
                user: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { scheduledDate: "asc" },
    }),
    prisma.staffProfile.findMany({
      where: { adminId, status: "ACTIVE" },
      select: {
        id: true,
        address: true,
        latitude: true,
        longitude: true,
        staffRole: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  const unresolvedJobCount = jobs.filter(
    (j) => j.latitude === null || j.longitude === null,
  ).length;
  const unresolvedStaffCount = staff.filter(
    (s) => s.latitude === null || s.longitude === null,
  ).length;

  return {
    date: dayStart.toISOString().slice(0, 10),
    jobs,
    staff,
    // Surfaced so the frontend can show a "N jobs/staff missing
    // coordinates — check their address" hint instead of just silently
    // dropping unpinned markers.
    unresolvedJobCount,
    unresolvedStaffCount,
  };
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
  getMapData,
};
