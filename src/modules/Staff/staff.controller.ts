import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { staffService } from "./staff.service";

const getMyProfile = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const result = await staffService.getMyProfile(userId);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff profile retrieved successfully",
    data: result,
  });
});

const getAllStaff = catchAsync(async (req, res) => {
  const filters = {
    searchTerm: req.query.searchTerm as string,
    adminId: req.query.adminId as string,
    staffRole: req.query.staffRole as string,
  };

  const result = await staffService.getAllStaff(filters, req.user);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff retrieved successfully",
    data: result,
  });
});

const getStaffById = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await staffService.getStaffById(id as string);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff retrieved successfully",
    data: result,
  });
});

const updateStaff = catchAsync(async (req, res) => {
  const { id } = req.params;
  const payload = req.body;
  const result = await staffService.updateStaff(id as string, payload);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff updated successfully",
    data: result,
  });
});

const deleteStaff = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await staffService.deleteStaff(id as string);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Staff deleted successfully",
    data: result,
  });
});

export const staffController = {
  getMyProfile,
  getAllStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
};
