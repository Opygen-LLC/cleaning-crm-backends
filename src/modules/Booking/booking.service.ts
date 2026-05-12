import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generates a unique booking reference: #OP-BK-0001
 */
const generateBookingRef = async (): Promise<string> => {
  const last = await prisma.booking.findFirst({
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
const resolveAdminId = async (userId: string): Promise<string> => {
  const admin = await prisma.adminProfile.findUnique({ where: { userId } });
  if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
  return admin.id;
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
} as const;

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createBooking = async (payload: IBookingCreate, user: any) => {
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

  const bookingRef = await generateBookingRef();

  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.create({
      data: {
        bookingRef,
        adminId,
        clientId: payload.clientId,
        serviceType: payload.serviceType,
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
              data: payload.staffIds.map((staffId) => ({ staffId })),
            },
          },
        }),
      },
      include: bookingInclude,
    });

    // Update client aggregates
    await tx.client.update({
      where: { id: payload.clientId },
      data: {
        totalBookings: { increment: 1 },
        lastBookingDate: new Date(payload.scheduledDate),
      },
    });

    return booking;
  });
};

const getAllBookings = async (queryParams: IQueryParams, user: any) => {
  const adminId = await resolveAdminId(user.id);

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
  const adminId = await resolveAdminId(user.id);

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
  const adminId = await resolveAdminId(user.id);

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

  const data: Record<string, unknown> = { ...payload };
  if (payload.scheduledDate) {
    data.scheduledDate = new Date(payload.scheduledDate);
  }

  return prisma.booking.update({
    where: { id },
    data,
    include: bookingInclude,
  });
};

const updateBookingStatus = async (
  id: string,
  newStatus: BookingStatus,
  user: any,
) => {
  const adminId = await resolveAdminId(user.id);

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

  return prisma.booking.update({
    where: { id },
    data: { status: newStatus },
    include: bookingInclude,
  });
};

const deleteBooking = async (id: string, user: any) => {
  const adminId = await resolveAdminId(user.id);

  const existing = await prisma.booking.findFirst({ where: { id, adminId } });
  if (!existing) throw new AppError(status.NOT_FOUND, "Booking not found");

  if (existing.status === BookingStatus.IN_PROGRESS) {
    throw new AppError(
      status.BAD_REQUEST,
      "Cannot delete a booking that is in progress",
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.booking.delete({ where: { id } });

    // Roll back client booking count
    await tx.client.update({
      where: { id: existing.clientId },
      data: { totalBookings: { decrement: 1 } },
    });
  });
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
  const adminId = await resolveAdminId(user.id);

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
        data: payload.staffIds.map((staffId) => ({ bookingId, staffId })),
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
  const adminId = await resolveAdminId(user.id);

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
        select: { id: true, name: true },
      },
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
