import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { recurringBookingService } from "./recurringBooking.service";
import { IQueryParams } from "../../interface/query.interface";

const createSchedule = catchAsync(async (req, res) => {
  const result = await recurringBookingService.createSchedule(
    req.body,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.CREATED,
    success: true,
    message: "Recurring schedule created successfully",
    data: result,
  });
});

const getAllSchedules = catchAsync(async (req, res) => {
  const result = await recurringBookingService.getAllSchedules(
    req.query as IQueryParams,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Recurring schedules retrieved successfully",
    data: result.data,
    meta: result.meta,
  });
});

const getScheduleById = catchAsync(async (req, res) => {
  const result = await recurringBookingService.getScheduleById(
    req.params["id"] as string,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Recurring schedule retrieved successfully",
    data: result,
  });
});

const updateSchedule = catchAsync(async (req, res) => {
  const result = await recurringBookingService.updateSchedule(
    req.params["id"] as string,
    req.body,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Recurring schedule updated successfully",
    data: result,
  });
});

// PATCH /:id/status  { action: "pause" | "resume" | "cancel" }
const updateScheduleStatus = catchAsync(async (req, res) => {
  const { action } = req.body as { action: "pause" | "resume" | "cancel" };
  const id = req.params["id"] as string;

  let result;
  if (action === "pause")
    result = await recurringBookingService.pauseSchedule(id, req.user);
  else if (action === "resume")
    result = await recurringBookingService.resumeSchedule(id, req.user);
  else result = await recurringBookingService.cancelSchedule(id, req.user);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: `Schedule ${action}d successfully`,
    data: result,
  });
});

const deleteSchedule = catchAsync(async (req, res) => {
  await recurringBookingService.deleteSchedule(
    req.params["id"] as string,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Recurring schedule deleted successfully",
    data: null,
  });
});

const getScheduleStats = catchAsync(async (req, res) => {
  const result = await recurringBookingService.getScheduleStats(req.user);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Recurring schedule stats retrieved successfully",
    data: result,
  });
});

export const recurringBookingController = {
  createSchedule,
  getAllSchedules,
  getScheduleById,
  updateSchedule,
  updateScheduleStatus,
  deleteSchedule,
  getScheduleStats,
};
