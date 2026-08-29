import { z } from "zod";
import { Currency } from "../../generated/prisma/enums";
import { ONBOARDING_STEPS, SKIPPABLE_ONBOARDING_STEPS } from "./admin.constant";
import { businessHoursInputSchema, jsonArrayInput, nullableMultipartInput } from "./businessHours";

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
    businessType: nullableMultipartInput(z.string().trim().min(1).max(120)),
    businessEmail: nullableMultipartInput(z.string().trim().email().max(320)),
    businessDescription: nullableMultipartInput(z.string().trim().max(1000)),
    businessHours: businessHoursInputSchema,
    website: nullableMultipartInput(z.string().url()),
    currency: z.enum(Currency).optional(),
    mobileNumber: nullableMultipartInput(z.string().trim().min(3).max(40)),

    address: nullableMultipartInput(z.string().trim().max(300)),
    city: nullableMultipartInput(z.string().trim().min(1).max(120)),
    postcode: nullableMultipartInput(z.string().trim().max(32)),
    zipcode: nullableMultipartInput(z.string().trim().max(32)),
    // Accepts an ISO-3166-1 alpha-2 code (e.g. "GB") or an already-valid
    // Country enum value. The service resolves it to the Prisma enum.
    country: nullableMultipartInput(z.string().trim().min(1).max(64)),

    workLocations: jsonArrayInput(z.array(workLocationSchema).max(25)).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.postcode !== undefined && value.zipcode !== undefined && value.postcode !== value.zipcode) {
      ctx.addIssue({ code: "custom", path: ["postcode"], message: "postcode conflicts with legacy zipcode" });
    }
  });

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

const onboardingClientErrorSchema = z
  .object({
    message: z.string().trim().min(1).max(1000),
    errorName: z.string().trim().min(1).max(160),
    errorKind: z.enum(["chunk-load", "api-contract", "type-error", "react-render", "unknown"]),
    stack: z.string().max(6000).nullable().optional(),
    digest: z.string().max(256).nullable().optional(),
    route: z.string().trim().min(1).max(800),
    releaseVersion: z.string().trim().min(1).max(160),
    apiRequestId: z.string().trim().max(160).nullable().optional(),
    relatedTraceId: z.string().trim().regex(/^[0-9a-f]{32}$/i).nullable().optional(),
    browser: z.string().trim().min(1).max(600),
    bootstrapSchemaVersion: z.number().int().min(1).max(1000),
    section: z.enum(["route", "active-step", "preview", "bootstrap"]),
    onboardingStep: z.enum(onboardingStepKeys).nullable().optional(),
    componentStack: z.string().max(6000).nullable().optional(),
  })
  .strict();

export const adminValidation = {
  createAdmin: createAdminSchema,
  updateAdmin: updateAdminSchema,
  updateWorkLocation: updateWorkLocationSchema,
  completeOnboardingStep: completeOnboardingStepSchema,
  skipOnboardingStep: skipOnboardingStepSchema,
  onboardingClientError: onboardingClientErrorSchema,
};
