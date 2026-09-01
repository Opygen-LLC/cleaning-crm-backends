import { prisma } from "../../lib/prisma/prisma";
import { formatMoney } from "../../lib/utils/money";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { invalidateAnalyticsCache } from "../../lib/utils/invalidateAnalyticsCache";
import status from "http-status";
import { BookingStatus, FormSubmissionStatus, UserRole } from "../../generated/prisma/enums";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";
import {
  IBookingCreate,
  IBookingUpdate,
  IBookingSubmissionConversion,
  IAssignStaff,
  ICalendarQuery,
} from "./booking.interface";
import {
  bookingSearchableFields,
  bookingFilterableFields,
} from "./booking.constant";
import { IRequestUser } from "../../types/requestUser.interface";
import { assertWithinLimit } from "../../lib/utils/checkPlanLimits";
import { requireE164Phone } from "../../lib/validation/phone";
import { syncBookingWebsiteSubmissionStatus } from "../Website/websiteSubmission.service";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { createNotification } from "../../lib/utils/createNotification";
import { NotificationType } from "../../generated/prisma/enums";
import { notificationService } from "../Settings/notification.service";
import logger from "../../lib/logger";
import { resolveServiceIdentity, serviceDisplayName } from "../../lib/utils/serviceIdentity";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import type { Prisma } from "../../generated/prisma/client";
import { nextReference } from "../../lib/utils/referenceNumber";
import { observeBackgroundTask } from "../../lib/monitoring/observeBackgroundTask";
import { queueBookingNotification } from "../../lib/notifications/businessNotificationEvents";
import { bookingDetailSelect, bookingListSelect, bookingMutationSelect } from "./booking.projection";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Allocate a globally unique booking reference under the shared transaction lock. */
const generateBookingRef = (tx: Prisma.TransactionClient): Promise<string> =>
  nextReference(tx, "booking");

/**
 * Resolve adminProfile.id from the authenticated user id.
 * Throws 404 when not found.
 */

/**
 * Resolves the clientId to book against.
 *
 * - If `clientId` is supplied, verifies it belongs to this admin.
 * - Otherwise treats the payload as a brand-new lead (e.g. a converted
 *   Online Booking / Estimate Form submission): reuses an existing client
 *   with a matching email if one exists, or creates a new one — so the
 *   "Convert to booking" action always succeeds for leads who aren't
 *   already clients.
 */
const resolveOrCreateClient = async (
  adminId: string,
  payload: IBookingCreate,
): Promise<string> => {
  if (payload.clientId) {
    const client = await prisma.client.findFirst({
      where: { id: payload.clientId, adminId },
    });
    if (!client) throw new AppError(status.NOT_FOUND, "Client not found");
    return client.id;
  }

  const email = payload.clientEmail!.trim();

  const existing = await prisma.client.findUnique({
    where: { email_adminId: { email, adminId } },
  });
  if (existing) return existing.id;

  // Brand-new client — enforce plan limits before inserting.
  await assertWithinLimit(adminId, "client");

  const created = await prisma.client.create({
    data: {
      adminId,
      name: payload.clientName!.trim(),
      email,
      phone: requireE164Phone(payload.clientPhone!, "clientPhone"),
      addressLine1: payload.address,
      city: "",
      zipcode: "",
      country: "",
    },
  });

  return created.id;
};

// ─── Standard includes shared across queries ──────────────────────────────────

const bookingInclude = {
  admin: { select: { currency: true } },
  client: {
    select: { id: true, name: true, email: true, phone: true },
  },
  staffAssignments: {
    select: {
      staff: {
        select: {
          id: true,
          staffRole: true,
          mobileNumber: true,
          specialty: true,
          status: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  },
  job: { select: { id: true, jobRef: true, status: true } },
  serviceCatalog: { select: { id: true, serviceName: true, basePrice: true, duration: true, category: true } },
} as const;

// Booking list/calendar reads stay lean. The detail endpoint additionally
// exposes the linked online-booking acquisition snapshot so staff can see the
// property answers and customer-selected extras without duplicating that data
// into a second website booking model.
const bookingDetailInclude = {
  ...bookingInclude,
  sourceBookingFormSubmission: {
    select: {
      ref: true,
      source: true,
      sourcePage: true,
      propertyType: true,
      bedrooms: true,
      bathrooms: true,
      answers: true,
      addOnSnapshot: true,
    },
  },
} as const;

// ── Booking confirmation email helper ─────────────────────────────────────────

type BookingEmailPayload = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

const sendBookingEmail = async (
  booking: BookingEmailPayload,
  eventType: "created" | "completed" | "cancelled" = "created",
) => {
  const clientEmail = booking.client?.email;
  if (!clientEmail) return;

  // Verify admin preference before dispatching
  const prefKey =
    eventType === "cancelled" ? "emailBookingCancelled" : "emailNewBooking";

  const allowed = await notificationService.shouldSendEmail(
    booking.adminId,
    prefKey,
  );
  if (!allowed) {
    logger.info(
      `[EMAIL NOTICE] Skipping ${eventType} email for booking ${booking.bookingRef} per admin preference.`,
    );
    return;
  }

  const fmt = (d: Date) =>
    d.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

  const staffNames: string[] = booking.staffAssignments.map(
    (assignment) => assignment.staff.user?.name ?? "Staff",
  );

  const subjectMap = {
    created: `Booking confirmed — ${booking.bookingRef}`,
    completed: `Your cleaning is complete — ${booking.bookingRef}`,
    cancelled: `Booking cancelled — ${booking.bookingRef}`,
  };

  await sendEmailSafely({
    adminId: booking.adminId,
    to: clientEmail,
    subject: subjectMap[eventType],
    templateName: "booking-confirmation",
    useBusinessTemplate: eventType === "created",
    templateData: {
      clientName: booking.client?.name ?? "Valued Customer",
      bookingRef: booking.bookingRef,
      serviceType: serviceDisplayName(booking),
      scheduledDate: fmt(new Date(booking.scheduledDate)),
      durationMins: booking.durationMins,
      address: booking.address,
      total: formatMoney(booking.total, booking.admin?.currency),
      notes: booking.notes ?? null,
      staffNames,
      isCompleted: eventType === "completed",
      isCancelled: eventType === "cancelled",
    },
  });
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createBooking = async (payload: IBookingCreate, user: IRequestUser) => {
  const adminId = await getAdminId(user);

  // Enforce plan limits before inserting
  await assertWithinLimit(adminId, "booking");
  const serviceIdentity = await resolveServiceIdentity(adminId, payload);

  // Resolve an existing client, or create one inline for a new lead
  const clientId = await resolveOrCreateClient(adminId, payload);

  // Verify quote belongs to this admin (if provided)
  if (payload.quoteId) {
    const quote = await prisma.quote.findFirst({
      where: { id: payload.quoteId, adminId },
    });
    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");
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

  const booking = await prisma.$transaction(async (tx) => {
    const bookingRef = await generateBookingRef(tx);
    const newBooking = await tx.booking.create({
      data: {
        bookingRef,
        adminId,
        clientId,
        serviceCatalogId: serviceIdentity.serviceCatalogId,
        serviceType: serviceIdentity.serviceType,
        serviceNameSnapshot: serviceIdentity.serviceNameSnapshot,
        priceSnapshot: serviceIdentity.priceSnapshot,
        durationSnapshot: serviceIdentity.durationSnapshot,
        address: payload.address,
        scheduledDate: new Date(payload.scheduledDate),
        durationMins: payload.durationMins,
        total: payload.total,
        notes: payload.notes,
        quoteId: payload.quoteId,
        // Create staff assignments inline if provided
        ...(payload.staffIds?.length && {
          staffAssignments: {
            createMany: {
              data: payload.staffIds.map((staffId) => ({
                staffId,
              })),
            },
          },
        }),
      },
      include: bookingInclude,
    });

    // Update client aggregates
    await tx.client.update({
      where: { id: clientId },
      data: {
        totalBookings: { increment: 1 },
        lastBookingDate: new Date(payload.scheduledDate),
      },
    });

    return newBooking;
  });

  // Fire confirmation email (non-blocking)
  await queueBookingNotification(booking.id, "booking-confirmation");

  // Persist notification + push to bell
  createNotification({
    adminId: adminId,
    type: NotificationType.BOOKING,
    title: `New booking — ${booking.bookingRef}`,
    message: `${booking.client.name} booked ${serviceDisplayName(booking)}`,
    relatedId: booking.id,
  }).catch(() => {});
  invalidateAnalyticsCache(adminId);

  return {
    id: booking.id,
    bookingRef: booking.bookingRef,
    status: booking.status,
    scheduledDate: booking.scheduledDate,
    updatedAt: booking.updatedAt,
  };
};

/**
 * Convert an Online Booking submission into a real Booking atomically.
 *
 * One conversion primitive powers both the authenticated admin action and the
 * trusted website acquisition path. The website never writes a second booking
 * model: it creates a BookingFormSubmission, then this function creates the
 * canonical Booking/Client and links the submission with convertedBookingId.
 */
const convertBookingFormSubmissionForAdmin = async (
  submissionId: string,
  payload: IBookingSubmissionConversion,
  adminId: string,
) => {
  const preview = await prisma.bookingFormSubmission.findFirst({
    where: { id: submissionId, form: { adminId } },
    select: {
      id: true,
      email: true,
      convertedBookingId: true,
      convertedBooking: { include: bookingInclude },
    },
  });
  if (!preview) throw new AppError(status.NOT_FOUND, "Booking submission not found");
  if (preview.convertedBooking) {
    return { booking: preview.convertedBooking, alreadyConverted: true };
  }

  await assertWithinLimit(adminId, "booking");
  const existingClient = await prisma.client.findUnique({
    where: { email_adminId: { email: preview.email.trim().toLowerCase(), adminId } },
    select: { id: true },
  });
  if (!existingClient) await assertWithinLimit(adminId, "client");

  const result = await prisma.$transaction(async (tx) => {
    await acquireExtendedTextTransactionAdvisoryLock(tx, `booking-form-convert:${submissionId}`);

    const submission = await tx.bookingFormSubmission.findFirst({
      where: { id: submissionId, form: { adminId } },
      include: {
        serviceCatalog: {
          select: {
            id: true,
            adminId: true,
            serviceName: true,
            basePrice: true,
            duration: true,
            legacyServiceType: true,
          },
        },
        convertedBooking: { include: bookingInclude },
      },
    });
    if (!submission) throw new AppError(status.NOT_FOUND, "Booking submission not found");
    if (submission.convertedBooking) {
      return { booking: submission.convertedBooking, alreadyConverted: true };
    }
    if (submission.status === FormSubmissionStatus.CONVERTED) {
      throw new AppError(status.CONFLICT, "This legacy converted submission is not linked to its booking", {
        code: "LEGACY_CONVERSION_UNLINKED",
        retryable: false,
      });
    }
    if (submission.status === FormSubmissionStatus.DECLINED) {
      throw new AppError(status.CONFLICT, "Declined submissions cannot be converted to bookings", {
        code: "BOOKING_SUBMISSION_DECLINED",
        retryable: false,
      });
    }

    let catalog = submission.serviceCatalog;
    if (catalog && catalog.adminId !== adminId) {
      throw new AppError(status.CONFLICT, "Submission service does not belong to this business", {
        code: "SERVICE_TENANT_MISMATCH",
        retryable: false,
      });
    }

    if (!catalog && submission.serviceType) {
      const matches = await tx.serviceCatalog.findMany({
        where: { adminId, legacyServiceType: submission.serviceType },
        orderBy: { createdAt: "asc" },
        take: 2,
        select: {
          id: true,
          adminId: true,
          serviceName: true,
          basePrice: true,
          duration: true,
          legacyServiceType: true,
        },
      });
      catalog = matches.length === 1 ? matches[0] : null;
    }

    if (!catalog && !submission.serviceType) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, "This submission has no valid service identity", {
        code: "BOOKING_SUBMISSION_SERVICE_MISSING",
        retryable: false,
      });
    }

    const email = submission.email.trim().toLowerCase();
    let client = await tx.client.findUnique({
      where: { email_adminId: { email, adminId } },
      select: { id: true },
    });
    if (!client) {
      client = await tx.client.create({
        data: {
          adminId,
          name: submission.name.trim(),
          email,
          phone: requireE164Phone(submission.phone, "phone"),
          addressLine1: submission.address,
          city: "",
          zipcode: "",
          country: "",
        },
        select: { id: true },
      });
    }

    if (payload.staffIds?.length) {
      const uniqueStaffIds = [...new Set(payload.staffIds)];
      const staffCount = await tx.staffProfile.count({
        where: { id: { in: uniqueStaffIds }, adminId },
      });
      if (staffCount !== uniqueStaffIds.length) {
        throw new AppError(status.BAD_REQUEST, "One or more staff members not found");
      }
    }

    const bookingRef = await generateBookingRef(tx);
    const serviceType = catalog?.legacyServiceType ?? submission.serviceType ?? null;
    const serviceNameSnapshot =
      submission.serviceNameSnapshot ??
      catalog?.serviceName ??
      (serviceType ? serviceType.toLowerCase().split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ") : "Service");

    const booking = await tx.booking.create({
      data: {
        bookingRef,
        adminId,
        clientId: client.id,
        serviceCatalogId: catalog?.id ?? null,
        serviceType,
        serviceNameSnapshot,
        priceSnapshot: submission.priceSnapshot ?? catalog?.basePrice ?? null,
        durationSnapshot: submission.durationSnapshot ?? catalog?.duration ?? null,
        addOnSnapshot: (submission.addOnSnapshot ?? []) as Prisma.InputJsonValue,
        address: submission.address,
        scheduledDate: new Date(payload.scheduledDate),
        durationMins: payload.durationMins,
        total: payload.total,
        notes: payload.notes ?? submission.notes ?? undefined,
        ...(payload.staffIds?.length
          ? { staffAssignments: { createMany: { data: [...new Set(payload.staffIds)].map((staffId) => ({ staffId })) } } }
          : {}),
      },
      include: bookingInclude,
    });

    await tx.client.update({
      where: { id: client.id },
      data: {
        totalBookings: { increment: 1 },
        lastBookingDate: new Date(payload.scheduledDate),
      },
    });

    await tx.bookingFormSubmission.update({
      where: { id: submission.id },
      data: {
        status: FormSubmissionStatus.CONVERTED,
        convertedBookingId: booking.id,
        convertedAt: new Date(),
        serviceCatalogId: catalog?.id ?? submission.serviceCatalogId,
        serviceType,
        serviceNameSnapshot,
        priceSnapshot: submission.priceSnapshot ?? catalog?.basePrice ?? null,
        durationSnapshot: submission.durationSnapshot ?? catalog?.duration ?? null,
      },
    });
    await syncBookingWebsiteSubmissionStatus(tx, submission.id, FormSubmissionStatus.CONVERTED);

    return { booking, alreadyConverted: false };
  });

  if (!result.alreadyConverted) {
    await queueBookingNotification(result.booking.id, "booking-confirmation");
    createNotification({
      adminId,
      type: NotificationType.BOOKING,
      title: `New booking — ${result.booking.bookingRef}`,
      message: `${result.booking.client.name} booked ${serviceDisplayName(result.booking)}`,
      relatedId: result.booking.id,
    }).catch(() => {});
    invalidateAnalyticsCache(adminId);
  }

  return result;
};

const convertBookingFormSubmission = async (
  submissionId: string,
  payload: IBookingSubmissionConversion,
  user: IRequestUser,
) => convertBookingFormSubmissionForAdmin(submissionId, payload, await getAdminId(user));

/**
 * Trusted website conversion. Schedule, duration and total are derived from the
 * server-owned submission/form snapshots, never from browser-supplied booking
 * totals. If a prior request created the submission but failed before
 * conversion, retrying with the same Idempotency-Key safely resumes here.
 */
const convertWebsiteBookingFormSubmission = async (submissionId: string, adminId: string) => {
  const submission = await prisma.bookingFormSubmission.findFirst({
    where: { id: submissionId, form: { adminId } },
    select: {
      id: true,
      date: true,
      timeSlot: true,
      priceSnapshot: true,
      totalSnapshot: true,
      convertedBookingId: true,
      form: { select: { slotDurationMinutes: true } },
    },
  });
  if (!submission) throw new AppError(status.NOT_FOUND, "Booking submission not found");

  const day = submission.date.toISOString().slice(0, 10);
  const scheduledDate = new Date(`${day}T${submission.timeSlot}:00.000Z`);
  if (Number.isNaN(scheduledDate.getTime())) {
    throw new AppError(status.CONFLICT, "Booking submission contains an invalid schedule", {
      code: "BOOKING_SUBMISSION_SCHEDULE_INVALID",
      retryable: false,
    });
  }

  const total = Number(submission.totalSnapshot ?? submission.priceSnapshot ?? 0);
  return convertBookingFormSubmissionForAdmin(
    submissionId,
    {
      scheduledDate,
      durationMins: submission.form.slotDurationMinutes,
      total: Number.isFinite(total) ? total : 0,
    },
    adminId,
  );
};

const getAllBookings = async (queryParams: IQueryParams, user: IRequestUser) => {
  const adminId = await getAdminId(user);

  return new QueryBuilder(prisma.booking, queryParams, {
    searchableFields: bookingSearchableFields,
    filterableFields: bookingFilterableFields,
  })
    .where({ adminId })
    .search()
    .filter()
    .sort()
    .paginate()
    .select(bookingListSelect)
    .execute();
};

const getBookingById = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);

  const booking = await prisma.booking.findFirst({
    where: { id, adminId },
    select: bookingDetailSelect,
  });

  if (!booking) throw new AppError(status.NOT_FOUND, "Booking not found");

  return booking;
};

const updateBooking = async (
  id: string,
  payload: IBookingUpdate,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);

  const existing = await prisma.booking.findFirst({ where: { id, adminId }, select: { id: true, status: true } });
  if (!existing) throw new AppError(status.NOT_FOUND, "Booking not found");

  if (
    existing.status === BookingStatus.COMPLETED ||
    existing.status === BookingStatus.CANCELLED
  ) {
    throw new AppError(
      status.BAD_REQUEST,
      `Cannot edit a booking with status ${existing.status}`,
    );
  }

  const { serviceCatalogId, serviceType, ...rest } = payload;
  const data: Record<string, unknown> = { ...rest };
  if (serviceCatalogId !== undefined || serviceType !== undefined) {
    const identity = await resolveServiceIdentity(adminId, { serviceCatalogId, serviceType });
    data.serviceCatalogId = identity.serviceCatalogId;
    data.serviceType = identity.serviceType;
    data.serviceNameSnapshot = identity.serviceNameSnapshot;
    data.priceSnapshot = identity.priceSnapshot;
    data.durationSnapshot = identity.durationSnapshot;
  }
  if (payload.scheduledDate) {
    data.scheduledDate = new Date(payload.scheduledDate);
  }

  const updated = await prisma.booking.update({
    where: { id },
    data,
    select: bookingMutationSelect,
  });
  invalidateAnalyticsCache(adminId);
  return updated;
};

const updateBookingStatus = async (
  id: string,
  newStatus: BookingStatus,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);

  const existing = await prisma.booking.findFirst({ where: { id, adminId } });
  if (!existing) throw new AppError(status.NOT_FOUND, "Booking not found");

  // Guard illegal status transitions
  const allowed: Record<BookingStatus, BookingStatus[]> = {
    [BookingStatus.SCHEDULED]: [
      BookingStatus.IN_PROGRESS,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.IN_PROGRESS]: [
      BookingStatus.COMPLETED,
      BookingStatus.CANCELLED,
    ],
    [BookingStatus.COMPLETED]: [],
    [BookingStatus.CANCELLED]: [],
  };

  if (!allowed[existing.status].includes(newStatus)) {
    throw new AppError(
      status.BAD_REQUEST,
      `Cannot transition from ${existing.status} to ${newStatus}`,
    );
  }

  const updated = await prisma.booking.update({
    where: { id },
    data: { status: newStatus },
    include: bookingInclude,
  });

  // Fire notification email when booking status changes to COMPLETED or CANCELLED
  if (newStatus === BookingStatus.COMPLETED) {
    observeBackgroundTask(sendBookingEmail(updated, "completed"), { operation: "booking_completed_email", adminId, entityType: "Booking", entityId: updated.id });
  } else if (newStatus === BookingStatus.CANCELLED) {
    observeBackgroundTask(sendBookingEmail(updated, "cancelled"), { operation: "booking_cancelled_email", adminId, entityType: "Booking", entityId: updated.id });
  }
  invalidateAnalyticsCache(adminId);

  return {
    id: updated.id,
    bookingRef: updated.bookingRef,
    status: updated.status,
    scheduledDate: updated.scheduledDate,
    updatedAt: updated.updatedAt,
  };
};

const deleteBooking = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);

  const existing = await prisma.booking.findFirst({ where: { id, adminId } });
  if (!existing) throw new AppError(status.NOT_FOUND, "Booking not found");

  if (existing.status === BookingStatus.IN_PROGRESS) {
    throw new AppError(
      status.BAD_REQUEST,
      "Cannot delete a booking that is in progress",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.booking.delete({ where: { id } });

    // Roll back client booking count
    await tx.client.update({
      where: { id: existing.clientId },
      data: { totalBookings: { decrement: 1 } },
    });
  });
  invalidateAnalyticsCache(adminId);
  return { id, deleted: true as const };
};

// ─── Staff Assignment ─────────────────────────────────────────────────────────

/**
 * Replaces the full staff assignment list for a booking.
 * Passing an empty staffIds array removes all assignments.
 */
const assignStaff = async (
  bookingId: string,
  payload: IAssignStaff,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, adminId },
  });
  if (!booking) throw new AppError(status.NOT_FOUND, "Booking not found");

  if (booking.status === BookingStatus.COMPLETED) {
    throw new AppError(
      status.BAD_REQUEST,
      "Cannot reassign staff on a completed booking",
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
    await tx.bookingStaffAssignment.deleteMany({ where: { bookingId } });

    // Create new set
    if (payload.staffIds.length) {
      await tx.bookingStaffAssignment.createMany({
        data: payload.staffIds.map((staffId) => ({
          bookingId,
          staffId,
        })),
      });
    }

    return tx.booking.findUnique({
      where: { id: bookingId },
      select: bookingMutationSelect,
    });
  });
};

// ─── Calendar View ────────────────────────────────────────────────────────────

/**
 * Returns all bookings for the given month, keyed by ISO date (YYYY-MM-DD)
 * for efficient calendar rendering on the frontend.
 */
const getCalendarView = async (query: ICalendarQuery, user: IRequestUser) => {
  const adminId = await getAdminId(user);

  const { year, month } = query;

  // Build exact month boundaries in UTC
  const from = new Date(Date.UTC(year, month - 1, 1)); // first day 00:00
  const to = new Date(Date.UTC(year, month, 1, 0, 0, -1)); // last ms of last day

  const bookings = await prisma.booking.findMany({
    where: {
      adminId,
      scheduledDate: { gte: from, lte: to },
    },
    include: {
      client: {
        // [Phase 2 — location-aware dispatch] Bookings don't carry
        // their own coordinates — they inherit the client's
        // geocoded address, since a booking's address is always
        // the client's address at time of booking.
        select: { id: true, name: true, latitude: true, longitude: true },
      },
      serviceCatalog: { select: { id: true, serviceName: true } },
      staffAssignments: {
        select: {
          staff: {
            select: {
              id: true,
              staffRole: true,
              user: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { scheduledDate: "asc" },
  });

  // Group by date key (YYYY-MM-DD) for calendar day cells
  const grouped: Record<string, typeof bookings> = {};

  for (const booking of bookings) {
    const dateKey = booking.scheduledDate.toISOString().split("T")[0];
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(booking);
  }

  return {
    year,
    month,
    totalBookings: bookings.length,
    days: grouped,
  };
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const bookingService = {
  createBooking,
  convertBookingFormSubmission,
  convertWebsiteBookingFormSubmission,
  getAllBookings,
  getBookingById,
  updateBooking,
  updateBookingStatus,
  deleteBooking,
  assignStaff,
  getCalendarView,
};
