import { Router } from "express";
import { adminController } from "./admin.controller";
import {
  ValidationProperty,
  zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { adminValidation } from "./admin.validation";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import { multerMemory } from "../../config/multerMemory";
import { convertHeicToPng } from "../../middlewares/convertHeicToPngMiddleware";
import AppError from "../../errorHelper/AppError";
import status from "http-status";

const router = Router();

router.get("/profile", checkAuth(UserRole.ADMIN), adminController.getAdmin);

router.patch(
  "/profile",
  checkAuth(UserRole.ADMIN),
  multerMemory.single("businessLogo"),
  convertHeicToPng,
  zodValidate(adminValidation.updateAdmin, ValidationProperty.BODY),
  adminController.updateAdmin,
);

router.patch(
  "/work-location/:id",
  checkAuth(UserRole.ADMIN),
  zodValidate(adminValidation.updateWorkLocation, ValidationProperty.BODY),
  adminController.updateWorkLocation,
);

router.delete(
  "/work-location/:id",
  checkAuth(UserRole.ADMIN),
  adminController.deleteWorkLocation,
);

/**
 * GET /api/v1/admin/usage
 *
 * Phase 3: now returns:
 *   {
 *     staffCount, clientCount, bookingCountThisMonth,   // real-time counts
 *     caps: { staff, clients, bookingsPerMonth },       // null = unlimited
 *     pct:  { staff, clients, bookingsPerMonth },       // 0-100 | null
 *     anyNearLimit,                                     // true if any >= 90%
 *     subscriptionId, planId                            // for cache-keying
 *   }
 *
 * No new middleware — auth guard is sufficient; subscription status gate is
 * already applied at router level in routes/index.ts.
 */
router.get("/usage", checkAuth(UserRole.ADMIN), adminController.getAdminUsage);

router.get(
  "/bootstrap",
  checkAuth(UserRole.ADMIN),
  (req, res, next) => {
    if (req.query.surface !== "onboarding") {
      return next(new AppError(status.BAD_REQUEST, "Unsupported bootstrap surface", {
        code: "INVALID_BOOTSTRAP_SURFACE",
        retryable: false,
        fieldErrors: { surface: 'Use surface="onboarding".' },
      }));
    }
    return adminController.getOnboardingBootstrap(req, res, next);
  },
);

router.post(
  "/client-errors/onboarding",
  checkAuth(UserRole.ADMIN),
  zodValidate(adminValidation.onboardingClientError, ValidationProperty.BODY),
  adminController.reportOnboardingClientError,
);

router.get(
  "/onboarding-status",
  checkAuth(UserRole.ADMIN),
  adminController.getOnboardingStatus,
);


router.put(
  "/onboarding/services",
  checkAuth(UserRole.ADMIN),
  zodValidate(adminValidation.saveOnboardingServices, ValidationProperty.BODY),
  adminController.saveOnboardingServices,
);

router.post(
  "/onboarding-status/step",
  checkAuth(UserRole.ADMIN),
  zodValidate(adminValidation.completeOnboardingStep, ValidationProperty.BODY),
  adminController.completeOnboardingStep,
);

router.post(
  "/onboarding-status/skip-setup",
  checkAuth(UserRole.ADMIN),
  adminController.skipWebsiteOnboardingSetup,
);

router.post(
  "/onboarding-status/complete",
  checkAuth(UserRole.ADMIN),
  adminController.finalizeOnboardingSetup,
);

router.post(
  "/onboarding-status/skip",
  checkAuth(UserRole.ADMIN),
  zodValidate(adminValidation.skipOnboardingStep, ValidationProperty.BODY),
  adminController.skipOnboardingStep,
);

router.post(
  "/onboarding-status/skip-all",
  checkAuth(UserRole.ADMIN),
  adminController.skipAllOnboarding,
);

export const adminRoutes = router;
