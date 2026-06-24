import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { staffService } from "./staff.service";
import { IQueryParams } from "../../interface/query.interface";

const createStaff = catchAsync(async (req, res) => {
  const result = await staffService.createStaff(req.body, req.user);
  sendResponse(res, {
    httpStatusCode: status.CREATED,
    success: true,
    message: "Staff created successfully",
    data: result,
  });
});

const getMyStaff = catchAsync(async (req, res) => {
  const result = await staffService.getMyStaff(
    req.query as IQueryParams,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff retrieved successfully",
    data: result,
  });
});

const getStaffById = catchAsync(async (req, res) => {
  const result = await staffService.getStaffById(
    req.params.id as string,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff retrieved successfully",
    data: result,
  });
});

const updateStaff = catchAsync(async (req, res) => {
  const result = await staffService.updateStaff(
    req.params.id as string,
    req.body,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff updated successfully",
    data: result,
  });
});

const deleteStaff = catchAsync(async (req, res) => {
  const result = await staffService.deleteStaff(
    req.params.id as string,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff deleted successfully",
    data: result,
  });
});

const updateAvailability = catchAsync(async (req, res) => {
  const result = await staffService.updateAvailability(
    req.params.id as string,
    req.body,
    req.user,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Availability updated successfully",
    data: result,
  });
});

// ─── Staff self-service ───────────────────────────────────────────────────────

/** GET /staff/me — logged-in staff member's own profile */
const getMyProfile = catchAsync(async (req, res) => {
  const result = await staffService.getMyProfile(req.user.id);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Profile retrieved successfully",
    data: result,
  });
});

/** PATCH /staff/me — update personal details */
const updateMyProfile = catchAsync(async (req, res) => {
  const result = await staffService.updateMyProfile(req.user.id, req.body);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Profile updated successfully",
    data: result,
  });
});

/** POST /staff/me/avatar — upload profile photo to Cloudinary */
const uploadMyAvatar = catchAsync(async (req, res) => {
  if (!req.file) {
    sendResponse(res, {
      httpStatusCode: status.BAD_REQUEST,
      success: false,
      message: "No file uploaded",
    });
    return;
  }

  const result = await staffService.uploadMyAvatar(
    req.user.id,
    req.file.buffer,
    req.file.mimetype,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Avatar uploaded successfully",
    data: result,
  });
});

export const staffController = {
  createStaff,
  getMyStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
  updateAvailability,
  // New
  getMyProfile,
  updateMyProfile,
  uploadMyAvatar,
};
