import { z } from "zod";

// ─── Create Admin Account (super-admin endpoint) ───────────────────────────────
// Mirrors the fields the service actually consumes.
// Extra fields sent by the frontend (plan, billingCycle, country …) are
// simply stripped by Zod's `strip` default — no error, no leak.

export const createAdminAccountSchema = z.object({
    name: z
        .string({ message: "name is required." })
        .min(2, "name must be at least 2 characters.")
        .max(80, "name must be at most 80 characters.")
        .trim(),

    email: z
        .string({ message: "email is required." })
        .email("email must be a valid email address.")
        .toLowerCase()
        .trim(),

    password: z
        .string({ message: "password is required." })
        .min(8, "password must be at least 8 characters.")
        .max(128, "password must be at most 128 characters.")
        .regex(/[A-Z]/, "password must contain at least one uppercase letter.")
        .regex(/[0-9]/, "password must contain at least one number."),

    businessName: z
        .string({ message: "businessName is required." })
        .min(2, "businessName must be at least 2 characters.")
        .max(80, "businessName must be at most 80 characters.")
        .trim(),

    // ── Optional metadata fields ───────────────────────────────────────────────
    // sendWelcomeEmail controls whether the admin-created email is sent.
    // Remaining optional fields (plan, billingCycle, country, role, notes …)
    // are accepted and stripped by Zod — reserved for future plan assignment.
    sendWelcomeEmail: z.boolean().optional().default(true),
});

export type TCreateAdminAccountPayload = z.infer<
    typeof createAdminAccountSchema
>;

// ─── Subscription plan editor ────────────────────────────────────────────────

const planFeatureSchema = z.object({
    label: z.string().trim().min(1).max(120),
    included: z.boolean(),
    limit: z.string().trim().max(120).optional(),
});

const planFeaturesSchema = z
    .array(planFeatureSchema)
    .max(100, "A plan can contain at most 100 feature rows.")
    .superRefine((features, ctx) => {
        const seen = new Map<string, number>();
        features.forEach((feature, index) => {
            const key = feature.label
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .trim();
            const previous = seen.get(key);
            if (previous !== undefined) {
                ctx.addIssue({
                    code: "custom",
                    path: [index, "label"],
                    message: `Duplicate feature label. It already appears at row ${previous + 1}.`,
                });
            } else if (key) {
                seen.set(key, index);
            }
        });
    });

const nonNegativeAmount = z.number().finite().min(0);

const pricingPatchFieldsSchema = z.object({
    price: nonNegativeAmount.optional(),
    baseCharge: nonNegativeAmount.optional(),
    pricePerStaff: nonNegativeAmount.optional(),
    pricePerClient: nonNegativeAmount.optional(),
    pricePerBooking: nonNegativeAmount.optional(),
    maxStaff: z.number().int().min(0).nullable().optional(),
    maxClient: z.number().int().min(0).nullable().optional(),
    maxBookingsPerMonth: z.number().int().min(0).nullable().optional(),
    discount: z.number().finite().min(0).max(100).optional(),
    discountEndDate: z.string().datetime().nullable().optional(),
});

const pricingTierSchema = pricingPatchFieldsSchema.extend({
    interval: z.enum(["MONTHLY", "YEARLY"]),
    price: nonNegativeAmount,
});

const pricingTierUpdateSchema = pricingPatchFieldsSchema
    .extend({ interval: z.enum(["MONTHLY", "YEARLY"]) })
    .refine(
        (value) => Object.keys(value).some((key) => key !== "interval"),
        { message: "Provide at least one pricing field to update." },
    );

type PlanValidationContext = {
    addIssue: (issue: {
        code: "custom";
        path?: (string | number)[];
        message: string;
    }) => void;
};

const uniquePricingIntervals = (
    plans: { interval: "MONTHLY" | "YEARLY" }[],
    ctx: PlanValidationContext,
) => {
    const seen = new Set<string>();
    plans.forEach((plan, index) => {
        if (seen.has(plan.interval)) {
            ctx.addIssue({
                code: "custom",
                path: [index, "interval"],
                message: `Only one ${plan.interval.toLowerCase()} pricing row is allowed.`,
            });
        }
        seen.add(plan.interval);
    });
};

export const createSubscriptionPlanSchema = z
    .object({
        name: z.enum(["STARTER", "GROWTH", "PRO", "CUSTOM"]),
        description: z.string().trim().max(500).optional(),
        currency: z.enum(["USD", "EUR", "GBP", "CAD", "AUD"]).default("USD"),
        features: planFeaturesSchema.default([]),
        plans: z.array(pricingTierSchema).length(2),
    })
    .superRefine((value, ctx) => {
        uniquePricingIntervals(value.plans, ctx);
        const intervals = new Set(value.plans.map((plan) => plan.interval));
        if (!intervals.has("MONTHLY") || !intervals.has("YEARLY")) {
            ctx.addIssue({
                code: "custom",
                path: ["plans"],
                message: "Both monthly and yearly pricing rows are required.",
            });
        }
    });

export const updateSubscriptionPlanSchema = z
    .object({
        description: z.string().trim().max(500).optional(),
        currency: z.enum(["USD", "EUR", "GBP", "CAD", "AUD"]).optional(),
        features: planFeaturesSchema.optional(),
        isActive: z.boolean().optional(),
        plans: z.array(pricingTierUpdateSchema).min(1).max(2).optional(),
    })
    .superRefine((value, ctx) => {
        if (value.plans) uniquePricingIntervals(value.plans, ctx);
        if (Object.keys(value).length === 0) {
            ctx.addIssue({
                code: "custom",
                message: "Provide at least one plan field to update.",
            });
        }
    });

export const toggleSubscriptionPlanStatusSchema = z.object({
    isActive: z.boolean(),
});

export const updatePricingTierSchema = pricingPatchFieldsSchema.refine(
    (value) => Object.keys(value).length > 0,
    { message: "Provide at least one pricing field to update." },
);

export type TCreateSubscriptionPlanPayload = z.infer<
    typeof createSubscriptionPlanSchema
>;
export type TUpdateSubscriptionPlanPayload = z.infer<
    typeof updateSubscriptionPlanSchema
>;
