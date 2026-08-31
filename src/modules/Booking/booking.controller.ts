import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { bookingService } from "./booking.service";
import { IQueryParams } from "../../interface/query.interface";
import { bumpCacheResourcesForUser, CacheResource } from "../../lib/cache/resourceCacheVersion";

// ── CRUD ──────────────────────────────────────────────────────────────────────

const createBooking = catchAsync(async (req, res) => {
  const result = await bookingService.createBooking(req.body, req.user);
  await bumpCacheResourcesForUser(req.user, [CacheResource.bookings, CacheResource.dashboard, CacheResource.reports]);

  sendResponse(res, {
    httpStatusCode: status.CREATED,
    success: true,
    message: "Booking created successfully",
    data: result,
  });
});

const getAllBookings = catchAsync(async (req, res) => {
  const queryParams = req.query as IQueryParams;

  const result = await bookingService.getAllBookings(queryParams, req.user);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Bookings retrieved successfully",
    data: result.data,
    meta: result.meta,
  });
});

const getBookingById = catchAsync(async (req, res) => {
  const result = await bookingService.getBookingById(
    req.params.id as string,
    req.user,
  );

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Booking retrieved successfully",
    data: result,
  });
});

const updateBooking = catchAsync(async (req, res) => {
  const result = await bookingService.updateBooking(
    req.params.id as string,
    req.body,
    req.user,
  );

  await bumpCacheResourcesForUser(req.user, [CacheResource.bookings, CacheResource.dashboard, CacheResource.reports]);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Booking updated successfully",
    data: result,
  });
});

const updateBookingStatus = catchAsync(async (req, res) => {
  const result = await bookingService.updateBookingStatus(
    req.params.id as string,
    req.body.status,
    req.user,
  );

  await bumpCacheResourcesForUser(req.user, [CacheResource.bookings, CacheResource.dashboard, CacheResource.reports]);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Booking status updated successfully",
    data: result,
  });
});

const deleteBooking = catchAsync(async (req, res) => {
  await bookingService.deleteBooking(req.params.id as string, req.user);
  await bumpCacheResourcesForUser(req.user, [CacheResource.bookings, CacheResource.dashboard, CacheResource.reports]);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Booking deleted successfully",
    data: null,
  });
});

// ── Staff Assignment ──────────────────────────────────────────────────────────

const assignStaff = catchAsync(async (req, res) => {
  const result = await bookingService.assignStaff(
    req.params.id as string,
    req.body,
    req.user,
  );

  await bumpCacheResourcesForUser(req.user, [CacheResource.bookings, CacheResource.dashboard]);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff assigned successfully",
    data: result,
  });
});

// ── Calendar ──────────────────────────────────────────────────────────────────

const getCalendarView = catchAsync(async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);

  const result = await bookingService.getCalendarView(
    { year, month },
    req.user,
  );

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Calendar view retrieved successfully",
    data: result,
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

export const bookingController = {
  createBooking,
  getAllBookings,
  getBookingById,
  updateBooking,
  updateBookingStatus,
  deleteBooking,
  assignStaff,
  getCalendarView,
};
