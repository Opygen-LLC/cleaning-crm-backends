import { z } from "zod";
import { Currency, DiscountType } from "../../generated/prisma/enums";

const createCouponSchema = z.object({
    code:          z.string().min(3, "Code must be at least 3 characters").max(32),
    description:   z.string().max(255).optional(),
    discountType:  z.nativeEnum(DiscountType),
    discountValue: z.number().positive("Discount value must be positive"),
    currency:      z.nativeEnum(Currency).nullable().optional(),
    maxUses:       z.number().int().positive().nullable().optional(),
    validFrom:     z.string().datetime().nullable().optional(),
    validUntil:    z.string().datetime().nullable().optional(),
    isActive:      z.boolean().optional(),
}).superRefine((value, ctx) => {
    if (value.discountType === DiscountType.FIXED && !value.currency) {
        ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency is required for fixed-amount coupons" });
    }
});

const updateCouponSchema = z.object({
    code:          z.string().min(3).max(32).optional(),
    description:   z.string().max(255).nullable().optional(),
    discountType:  z.nativeEnum(DiscountType).optional(),
    discountValue: z.number().positive().optional(),
    currency:      z.nativeEnum(Currency).nullable().optional(),
    maxUses:       z.number().int().positive().nullable().optional(),
    validFrom:     z.string().datetime().nullable().optional(),
    validUntil:    z.string().datetime().nullable().optional(),
    isActive:      z.boolean().optional(),
}).superRefine((value, ctx) => {
    if (value.discountType === DiscountType.FIXED && !value.currency) {
        ctx.addIssue({ code: "custom", path: ["currency"], message: "Currency is required when changing a coupon to a fixed amount" });
    }
});

const validateCouponSchema = z.object({
    code: z.string().min(1, "Coupon code is required"),
});

export const couponValidation = {
    createCoupon:   createCouponSchema,
    updateCoupon:   updateCouponSchema,
    validateCoupon: validateCouponSchema,
};
