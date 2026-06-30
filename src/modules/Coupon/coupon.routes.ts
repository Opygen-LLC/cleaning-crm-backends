import { Router } from "express";
import { couponController } from "./coupon.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { checkFeature } from "../../middlewares/checkSubscription";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { couponValidation } from "./coupon.validation";

const router = Router();

const isSuperAdmin = checkAuth(UserRole.SUPER_ADMIN);
// ADMIN can read and validate coupons but cannot create/delete — only SUPER_ADMIN can
const isSuperAdminOrAdmin = checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN);
// "coupons" is a PRO-tier feature (see seedSubscriptionPlan.ts). checkFeature
// short-circuits to next() for any non-ADMIN role (incl. SUPER_ADMIN), so on
// today's SUPER_ADMIN-only mutation routes below this is a no-op pass-through —
// it exists for defense-in-depth in case ADMIN-level coupon management is ever
// enabled on these same routes, and to gate the ADMIN-facing /validate route.
const hasCoupons = checkFeature("coupons");

// ── Stats ─────────────────────────────────────────────────────────────────────
// GET /api/v1/coupon/stats
// ADMIN can see stats for their own coupon usage; SUPER_ADMIN sees platform-wide
router.get("/stats", isSuperAdminOrAdmin, couponController.getCouponStats);

// ── Validate (used by checkout — admin auth) ──────────────────────────────────
// POST /api/v1/coupon/validate
router.post(
    "/validate",
    checkAuth(UserRole.ADMIN),
    hasCoupons,
    zodValidate(couponValidation.validateCoupon, ValidationProperty.BODY),
    couponController.validateCoupon,
);

// ── CRUD ──────────────────────────────────────────────────────────────────────
// POST /api/v1/coupon  — SUPER_ADMIN only (creation remains platform-level)
router.post(
    "/",
    isSuperAdmin,
    hasCoupons,
    zodValidate(couponValidation.createCoupon, ValidationProperty.BODY),
    couponController.createCoupon,
);

// GET /api/v1/coupon — ADMIN can list coupons to apply at checkout
router.get("/", isSuperAdminOrAdmin, couponController.getAllCoupons);

// GET /api/v1/coupon/:id — ADMIN can view coupon details
router.get("/:id", isSuperAdminOrAdmin, couponController.getCouponById);

// PATCH /api/v1/coupon/:id — SUPER_ADMIN only (editing remains platform-level)
router.patch(
    "/:id",
    isSuperAdmin,
    hasCoupons,
    zodValidate(couponValidation.updateCoupon, ValidationProperty.BODY),
    couponController.updateCoupon,
);

// PATCH /api/v1/coupon/:id/toggle — SUPER_ADMIN only
router.patch(
    "/:id/toggle",
    isSuperAdmin,
    hasCoupons,
    couponController.toggleCoupon,
);

// DELETE /api/v1/coupon/:id — SUPER_ADMIN only
router.delete("/:id", isSuperAdmin, hasCoupons, couponController.deleteCoupon);

export const couponRoutes = router;
