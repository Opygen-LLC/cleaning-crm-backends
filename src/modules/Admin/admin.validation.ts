import { z } from "zod";
import { Currency } from "../../generated/prisma/enums";
import { ONBOARDING_STEPS } from "./admin.constant";

export const createAdminSchema = z.object({
    businessName: z.string().min(1, "Business name is required"),
});

const workLocationSchema = z
    .object({
        city: z.string().min(1, "City is required"),
        postcode: z.string().optional(),
        notes: z.string().optional(),
    })
    .strict();

const updateAdminSchema = z
    .object({
        businessName: z.string().optional(),
        brandColor: z.string().optional(),
        businessType: z.string().optional(),
        businessEmail: z.string().email().optional(),
        website: z.string().url().optional(),
        currency: z.enum(Currency).optional(),
        mobileNumber: z.string().optional(),

        address: z.string().optional(),
        city: z.string().optional(),
        zipcode: z.string().optional(),
        // Accepts an ISO-3166-1 alpha-2 code (e.g. "KR") or an already-valid
        // Country enum value. Resolved to the real enum in admin.service via
        // resolveCountryEnum — see src/lib/constants/countryIsoMap.ts for why.
        country: z.string().min(1).max(64).optional(),

        workLocations: z.array(workLocationSchema).optional(),
    })
    .strict()
    .refine(
        (data) => Object.keys(data).length > 0 || true,
        {
            message: "At least one field must be provided to update",
        },
    );

const updateWorkLocationSchema = z
    .object({
        city: z.string().min(1, "City is required").optional(),
        postcode: z.string().optional(),
        notes: z.string().optional(),
    })
    .strict();

const onboardingStepKeys = ONBOARDING_STEPS.map((s) => s.key) as [
    (typeof ONBOARDING_STEPS)[number]["key"],
    ...(typeof ONBOARDING_STEPS)[number]["key"][],
];

const skipOnboardingStepSchema = z
    .object({
        step: z.enum(onboardingStepKeys),
    })
    .strict();

export const adminValidation = {
	createAdmin: createAdminSchema,
	updateAdmin: updateAdminSchema,
    updateWorkLocation: updateWorkLocationSchema,
    skipOnboardingStep: skipOnboardingStepSchema,
};