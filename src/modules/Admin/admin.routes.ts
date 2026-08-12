// ─── PHASE 3 NOTE ─────────────────────────────────────────────────────────────
// admin.routes.ts is UNCHANGED from the original — the GET /api/v1/admin/usage
// route was already registered here in Phase 2.  The Phase 3 change is purely
// in admin.service.ts (richer response payload) and admin.controller.ts.
//
// This file is included in the diff zip only so reviewers can see the full
// module, but you do not need to deploy it if you have already deployed the
// Phase 2 version.
// ─────────────────────────────────────────────────────────────────────────────

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
  "/onboarding-status",
  checkAuth(UserRole.ADMIN),
  adminController.getOnboardingStatus,
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
