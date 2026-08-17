import { z } from "zod";
import { Currency } from "../../generated/prisma/enums";
import { ONBOARDING_STEPS, SKIPPABLE_ONBOARDING_STEPS } from "./admin.constant";

export const createAdminSchema = z.object({
  businessName: z.string().min(1, "Business name is required"),
});

const workLocationSchema = z
  .object({
    city: z.string().trim().min(1, "City is required"),
    postcode: z.string().trim().max(32).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

const updateAdminSchema = z
  .object({
    businessName: z.string().trim().min(1).max(160).optional(),
    brandColor: z.string().optional(),
    businessType: z.string().trim().min(1).max(120).optional(),
    businessEmail: z.string().trim().email().max(320).optional(),
    businessDescription: z.string().trim().max(1000).optional(),
    website: z.string().url().optional(),
    currency: z.enum(Currency).optional(),
    mobileNumber: z.string().trim().min(3).max(40).optional(),

    address: z.string().trim().max(300).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    zipcode: z.string().trim().max(32).optional(),
    // Accepts an ISO-3166-1 alpha-2 code (e.g. "GB") or an already-valid
    // Country enum value. The service resolves it to the Prisma enum.
    country: z.string().trim().min(1).max(64).optional(),

    workLocations: z.array(workLocationSchema).max(25).optional(),
  })
  .strict();

const updateWorkLocationSchema = z
  .object({
    city: z.string().trim().min(1, "City is required").max(120).optional(),
    postcode: z.string().trim().max(32).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();


const onboardingStepKeys = ONBOARDING_STEPS.map((step) => step.key) as [
  (typeof ONBOARDING_STEPS)[number]["key"],
  ...(typeof ONBOARDING_STEPS)[number]["key"][],
];

const completeOnboardingStepSchema = z.object({
  step: z.enum(onboardingStepKeys),
}).strict();

const legacySkippableKeys = [...SKIPPABLE_ONBOARDING_STEPS] as [
  (typeof SKIPPABLE_ONBOARDING_STEPS)[number],
  ...(typeof SKIPPABLE_ONBOARDING_STEPS)[number][],
];

const skipOnboardingStepSchema = z
  .object({
    step: z.enum(legacySkippableKeys),
  })
  .strict();

export const adminValidation = {
  createAdmin: createAdminSchema,
  updateAdmin: updateAdminSchema,
  updateWorkLocation: updateWorkLocationSchema,
  completeOnboardingStep: completeOnboardingStepSchema,
  skipOnboardingStep: skipOnboardingStepSchema,
};
