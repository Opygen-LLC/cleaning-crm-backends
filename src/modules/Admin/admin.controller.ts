// ─── PHASE 3 CHANGE ──────────────────────────────────────────────────────────
// Only the `getAdminUsage` controller handler is relevant to this phase.
// It calls adminService.getAdminUsage which now returns caps + pct alongside
// counts.  The handler itself is structurally unchanged — just forwarded.
//
// Copy all other handlers from the original admin.controller.ts verbatim.
// ─────────────────────────────────────────────────────────────────────────────

import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { adminService } from "./admin.service";
import { uploadToCloudinary } from "../../lib/utils/cloudinary";

// ─── Existing handlers (unchanged) ───────────────────────────────────────────

const getAdmin = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const result = await adminService.getAdmin(userId);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Admin profile fetched successfully",
    data: result,
  });
});

const updateAdmin = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body;
  if (req.file) {
    const uploadResult = await uploadToCloudinary(req.file.buffer, {
      folder: "Cleaning-CRM/business-logos",
      public_id: `admin_${userId}_logo`,
      overwrite: true,
    });
    payload.businessLogo = uploadResult.secure_url;
  }
  const result = await adminService.updateAdmin(userId, payload);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Admin updated successfully",
    data: result,
  });
});

const updateWorkLocation = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const locationId = req.params.id;
  const payload = req.body;
  const result = await adminService.updateWorkLocation(
    userId,
    locationId as string,
    payload,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Work location updated successfully",
    data: result,
  });
});

const deleteWorkLocation = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const locationId = req.params.id;
  const result = await adminService.deleteWorkLocation(
    userId,
    locationId as string,
  );
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Work location deleted successfully",
    data: result,
  });
});

// ─── Phase 3: richer usage payload (counts + caps + pct + anyNearLimit) ───────

const getAdminUsage = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const result = await adminService.getAdminUsage(userId);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Admin usage fetched successfully",
    data: result,
  });
});

// ─── Onboarding handlers (unchanged) ─────────────────────────────────────────

const getOnboardingStatus = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const result = await adminService.getOnboardingStatus(userId);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Onboarding status fetched successfully",
    data: result,
  });
});

const skipOnboardingStep = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const { step } = req.body;
  const result = await adminService.skipOnboardingStep(userId, step);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Onboarding step skipped successfully",
    data: result,
  });
});

const skipAllOnboarding = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const result = await adminService.skipAllOnboarding(userId);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "All onboarding steps skipped successfully",
    data: result,
  });
});

export const adminController = {
  getAdmin,
  updateAdmin,
  updateWorkLocation,
  deleteWorkLocation,
  getAdminUsage,
  getOnboardingStatus,
  skipOnboardingStep,
  skipAllOnboarding,
};
