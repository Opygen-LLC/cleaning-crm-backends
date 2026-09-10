// ─── PHASE 3 CHANGE ──────────────────────────────────────────────────────────
import AppError from "../../errorHelper/AppError";
// Only the `getAdminUsage` controller handler is relevant to this phase.
// It calls adminService.getAdminUsage which now returns caps + pct alongside
// counts.  The handler itself is structurally unchanged — just forwarded.
//
// Copy all other handlers from the original admin.controller.ts verbatim.
// ─────────────────────────────────────────────────────────────────────────────

import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { adminService, toLegacyOnboardingBootstrap } from "./admin.service";
import { OnboardingSaveService } from "./onboardingSave.service";
import { mediaService } from "../Media/media.service";
import { bumpCacheResourcesForUser, CacheResource } from "../../lib/cache/resourceCacheVersion";
import { prisma } from "../../lib/prisma/prisma";

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
  const adminId = req.user.adminId;
  if (!adminId) throw new AppError(status.UNAUTHORIZED, "Authenticated admin context is missing");
  const payload = { ...req.body };
  const requestedAssetId = typeof payload.businessLogoAssetId === "string" ? payload.businessLogoAssetId : undefined;
  delete payload.businessLogoAssetId;
  const replacingLogo = Boolean(requestedAssetId || req.file);
  const previousLogo = replacingLogo
    ? await prisma.adminProfile.findUnique({ where: { id: adminId }, select: { businessLogoMediaAssetId: true } })
    : null;
  let replacementAssetId: string | null = null;

  if (requestedAssetId) {
    const asset = await mediaService.bindReadyAsset(requestedAssetId, req.user, "BUSINESS_LOGO");
    if (!asset.publicUrl) throw new AppError(status.CONFLICT, "Business logo is not publicly available yet.", { code: "MEDIA_NOT_READY", retryable: true });
    payload.businessLogo = asset.publicUrl;
    payload.businessLogoMediaAssetId = asset.id;
    replacementAssetId = asset.id;
  } else if (req.file) {
    const asset = await mediaService.uploadFromServer({
      purpose: "BUSINESS_LOGO",
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      buffer: req.file.buffer,
    }, req.user);
    if (!asset.publicUrl) throw new AppError(status.CONFLICT, "Business logo is not publicly available yet.", { code: "MEDIA_NOT_READY", retryable: true });
    payload.businessLogo = asset.publicUrl;
    payload.businessLogoMediaAssetId = asset.id;
    replacementAssetId = asset.id;
  }
  let result;
  try {
    result = await adminService.updateAdmin(userId, payload);
  } catch (error) {
    if (replacementAssetId) {
      await mediaService.deleteAssetIfUnreferencedForTenant(replacementAssetId, adminId).catch(() => undefined);
    }
    throw error;
  }
  if (previousLogo?.businessLogoMediaAssetId && previousLogo.businessLogoMediaAssetId !== replacementAssetId) {
    await mediaService.deleteAssetIfUnreferencedForTenant(previousLogo.businessLogoMediaAssetId, adminId).catch(() => undefined);
  }
  await bumpCacheResourcesForUser(req.user, [CacheResource.profile, CacheResource.dashboard]);
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
  await bumpCacheResourcesForUser(req.user, [CacheResource.profile]);
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
  await bumpCacheResourcesForUser(req.user, [CacheResource.profile]);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Work location deleted successfully",
    data: result,
  });
});

// ─── Phase 3: richer usage payload (counts + caps + pct + anyNearLimit) ───────

const getAdminUsage = catchAsync(async (req, res) => {
  const adminId = req.user.adminId;
  if (!adminId) throw new AppError(status.UNAUTHORIZED, "Authenticated admin context is missing");
  const result = await adminService.getAdminUsage(adminId);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Admin usage fetched successfully",
    data: result,
  });
});

// ─── Onboarding handlers (unchanged) ─────────────────────────────────────────

const getOnboardingBootstrap = catchAsync(async (req, res) => {
  const adminId = req.user.adminId;
  if (!adminId) throw new AppError(status.UNAUTHORIZED, "Authenticated admin context is missing");
  const result = await adminService.getOnboardingBootstrap(adminId);
  const version = req.query.schemaVersion;
  if (version !== undefined && version !== "1" && version !== "2") throw new AppError(status.BAD_REQUEST, "Unsupported onboarding schema version", { code: "ONBOARDING_SCHEMA_VERSION_UNSUPPORTED", retryable: false });
  res.setHeader("X-Bootstrap-Schema-Version", version === "2" ? "2" : "1");
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Onboarding bootstrap fetched successfully",
    data: version === "2" ? result : toLegacyOnboardingBootstrap(result),
  });
});

const reportOnboardingClientError = catchAsync(async (req, res) => {
  await adminService.reportOnboardingClientError(
    req.user.id,
    req.user.adminId,
    req.body,
    typeof res.locals.requestId === "string" ? res.locals.requestId : null,
  );
  res.status(status.NO_CONTENT).send();
});

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



const getOnboardingServices = catchAsync(async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Onboarding-Schema-Version", "2");
  sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Onboarding services loaded", data: await OnboardingSaveService.getServicesContext(req.user.id) });
});

const saveOnboardingStep = catchAsync(async (req, res) => {
  const result = await OnboardingSaveService.saveStep(req.user.id, req.body);
  res.setHeader("X-Onboarding-Schema-Version", "2");
  res.setHeader("Cache-Control", "private, no-store");
  sendResponse(res, { httpStatusCode: status.OK, success: true, message: "Onboarding step saved", data: result });
});

const saveOnboardingServices = catchAsync(async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Onboarding-Schema-Version", req.body.schemaVersion === 2 ? "2" : "1");
  const result = req.body.schemaVersion === 2
    ? await OnboardingSaveService.saveStep(req.user.id, req.body)
    : await adminService.saveOnboardingServices(req.user.id, req.body, {
    requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : null,
    traceId: typeof res.locals.traceId === "string" ? res.locals.traceId : null,
  });
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Services and website booking saved successfully",
    data: result,
  });
});

const completeOnboardingStep = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const result = await adminService.completeOnboardingStep(userId, req.body.step);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Onboarding step completed successfully",
    data: result,
  });
});

const skipWebsiteOnboardingSetup = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const result = await adminService.skipWebsiteOnboardingSetup(userId);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Website setup defaults selected successfully",
    data: result,
  });
});

const finalizeOnboardingSetup = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const result = await adminService.finalizeOnboardingSetup(userId);
  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Account setup completed successfully",
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
  getOnboardingServices,
  saveOnboardingStep,
  getAdmin,
  updateAdmin,
  updateWorkLocation,
  deleteWorkLocation,
  getAdminUsage,
  getOnboardingStatus,
  getOnboardingBootstrap,
  reportOnboardingClientError,
  saveOnboardingServices,
  completeOnboardingStep,
  skipWebsiteOnboardingSetup,
  finalizeOnboardingSetup,
  skipOnboardingStep,
  skipAllOnboarding,
};
