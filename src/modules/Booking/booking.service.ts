import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { invalidateAnalyticsCache } from "../../lib/utils/invalidateAnalyticsCache";
import status from "http-status";
import { BookingStatus, UserRole } from "../../generated/prisma/enums";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";
import {
  IBookingCreate,
  IBookingUpdate,
  IAssignStaff,
  ICalendarQuery,
} from "./booking.interface";
import {
  bookingSearchableFields,
  bookingFilterableFields,
} from "./booking.constant";
import { IRequestUser } from "../../types/requestUser.interface";
import { assertWithinLimit } from "../../lib/utils/checkPlanLimits";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { createNotification } from "../../lib/utils/createNotification";
import { NotificationType } from "../../generated/prisma/enums";
import { notificationService } from "../Settings/notification.service";
import logger from "../../lib/logger";
import { resolveServiceIdentity, serviceDisplayName } from "../../lib/utils/serviceIdentity";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generates a unique booking reference: #OP-BK-0001
 *
 * PERF FIX #8: The previous version queried ORDER BY createdAt DESC with no
 * adminId filter, causing a full-table sort as the bookings table grows.
 * Now scoped to adminId so the existing composite index
 * @@index([adminId, status, createdAt(sort: Desc)]) is used efficiently.
 */
const generateBookingRef = async (adminId: string): Promise<string> => {
  const last = await prisma.booking.findFirst({
    where: { adminId },
    orderBy: { createdAt: "desc" },
    select: { bookingRef: true },
  });

  let next = 1;
  if (last?.bookingRef) {
    const parts = last.bookingRef.split("-");
    const num = parseInt(parts[parts.length - 1]);
    if (!isNaN(num)) next = num + 1;
  }

  return `#OP-BK-${next.toString().padStart(4, "0")}`;
};

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
      phone: payload.clientPhone!.trim(),
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
  job: { select: { id: true, jobRef: true, status: true } },
  serviceCatalog: { select: { id: true, serviceName: true, basePriceGbp: true, duration: true, category: true } },
} as const;

// ── Booking confirmation email helper ─────────────────────────────────────────

const sendBookingEmail = async (
  booking: any,
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

  const staffNames: string[] = (booking.staffAssignments ?? []).map(
    (a: any) => a.staff?.user?.name ?? "Staff",
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
    templateData: {
      clientName: booking.client?.name ?? "Valued Customer",
      bookingRef: booking.bookingRef,
      serviceType: serviceDisplayName(booking),
      scheduledDate: fmt(new Date(booking.scheduledDate)),
      durationMins: booking.durationMins,
      address: booking.address,
      total: Number(booking.total).toFixed(2),
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

  const bookingRef = await generateBookingRef(adminId);

  const booking = await prisma.$transaction(async (tx) => {
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
  sendBookingEmail(booking, "created").catch(() => {});

  // Persist notification + push to bell
  createNotification({
    adminId: adminId,
    type: NotificationType.BOOKING,
    title: `New booking — ${booking.bookingRef}`,
    message: `${booking.client.name} booked ${serviceDisplayName(booking)}`,
    relatedId: booking.id,
  }).catch(() => {});
  invalidateAnalyticsCache(adminId);

  return booking;
};

const getAllBookings = async (queryParams: IQueryParams, user: any) => {
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
    .include(bookingInclude)
    .execute();
};

const getBookingById = async (id: string, user: any) => {
  const adminId = await getAdminId(user);

  const booking = await prisma.booking.findFirst({
    where: { id, adminId },
    include: bookingInclude,
  });

  if (!booking) throw new AppError(status.NOT_FOUND, "Booking not found");

  return booking;
};

const updateBooking = async (
  id: string,
  payload: IBookingUpdate,
  user: any,
) => {
  const adminId = await getAdminId(user);

  const existing = await prisma.booking.findFirst({ where: { id, adminId } });
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
    include: bookingInclude,
  });
  invalidateAnalyticsCache(adminId);
  return updated;
};

const updateBookingStatus = async (
  id: string,
  newStatus: BookingStatus,
  user: any,
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
    sendBookingEmail(updated, "completed").catch(() => {});
  } else if (newStatus === BookingStatus.CANCELLED) {
    sendBookingEmail(updated, "cancelled").catch(() => {});
  }
  invalidateAnalyticsCache(adminId);

  return updated;
};

const deleteBooking = async (id: string, user: any) => {
  const adminId = await getAdminId(user);

  const existing = await prisma.booking.findFirst({ where: { id, adminId } });
  if (!existing) throw new AppError(status.NOT_FOUND, "Booking not found");

  if (existing.status === BookingStatus.IN_PROGRESS) {
    throw new AppError(
      status.BAD_REQUEST,
      "Cannot delete a booking that is in progress",
    );
  }

  const deleted = await prisma.$transaction(async (tx) => {
    await tx.booking.delete({ where: { id } });

    // Roll back client booking count
    await tx.client.update({
      where: { id: existing.clientId },
      data: { totalBookings: { decrement: 1 } },
    });
  });
  invalidateAnalyticsCache(adminId);
  return deleted;
};

// ─── Staff Assignment ─────────────────────────────────────────────────────────

/**
 * Replaces the full staff assignment list for a booking.
 * Passing an empty staffIds array removes all assignments.
 */
const assignStaff = async (
  bookingId: string,
  payload: IAssignStaff,
  user: any,
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
      include: bookingInclude,
    });
  });
};

// ─── Calendar View ────────────────────────────────────────────────────────────

/**
 * Returns all bookings for the given month, keyed by ISO date (YYYY-MM-DD)
 * for efficient calendar rendering on the frontend.
 */
const getCalendarView = async (query: ICalendarQuery, user: any) => {
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
        include: {
          staff: {
            include: {
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
  getAllBookings,
  getBookingById,
  updateBooking,
  updateBookingStatus,
  deleteBooking,
  assignStaff,
  getCalendarView,
};
