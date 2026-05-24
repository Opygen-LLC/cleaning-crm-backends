import { Router } from "express";
import { couponController } from "./coupon.controller";
import { checkAuth } from "../../middlewares/checkAuth";
import { UserRole } from "../../generated/prisma/enums";
import {
    ValidationProperty,
    zodValidate,
} from "../../middlewares/validations/zodValidation.middleware";
import { couponValidation } from "./coupon.validation";

const router = Router();

const isSuperAdmin = checkAuth(UserRole.SUPER_ADMIN);

// ── Stats ─────────────────────────────────────────────────────────────────────
// GET /api/v1/coupon/stats
router.get("/stats", isSuperAdmin, couponController.getCouponStats);

// ── Validate (used by checkout — admin auth) ──────────────────────────────────
// POST /api/v1/coupon/validate
router.post(
    "/validate",
    checkAuth(UserRole.ADMIN),
    zodValidate(couponValidation.validateCoupon, ValidationProperty.BODY),
    couponController.validateCoupon,
);

// ── CRUD ──────────────────────────────────────────────────────────────────────
// POST /api/v1/coupon
router.post(
    "/",
    isSuperAdmin,
    zodValidate(couponValidation.createCoupon, ValidationProperty.BODY),
    couponController.createCoupon,
);

// GET /api/v1/coupon
router.get("/", isSuperAdmin, couponController.getAllCoupons);

// GET /api/v1/coupon/:id
router.get("/:id", isSuperAdmin, couponController.getCouponById);

// PATCH /api/v1/coupon/:id
router.patch(
    "/:id",
    isSuperAdmin,
    zodValidate(couponValidation.updateCoupon, ValidationProperty.BODY),
    couponController.updateCoupon,
);

// PATCH /api/v1/coupon/:id/toggle
router.patch("/:id/toggle", isSuperAdmin, couponController.toggleCoupon);

// DELETE /api/v1/coupon/:id
router.delete("/:id", isSuperAdmin, couponController.deleteCoupon);

export const couponRoutes = router;
