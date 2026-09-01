import { z } from "zod";
import { Currency, ServiceCategory } from "../../generated/prisma/enums";
import { ONBOARDING_STEPS, SKIPPABLE_ONBOARDING_STEPS } from "./admin.constant";
import { businessHoursInputSchema, jsonArrayInput, nullableMultipartInput } from "./businessHours";
import { e164PhoneSchema } from "../../lib/validation/phone";

const businessWebsiteUrlSchema = z
  .string()
  .trim()
  .transform((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`))
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.includes(".");
    } catch {
      return false;
    }
  }, "Invalid URL");

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
    licenseNumber: nullableMultipartInput(z.string().trim().min(1).max(80)),
    businessEmail: nullableMultipartInput(z.string().trim().email().max(320)),
    businessDescription: nullableMultipartInput(z.string().trim().max(1000)),
    businessHours: businessHoursInputSchema,
    website: nullableMultipartInput(businessWebsiteUrlSchema),
    currency: z.enum(Currency).optional(),
    mobileNumber: nullableMultipartInput(e164PhoneSchema()),

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


const onboardingServiceSchema = z.object({
  serviceCatalogId: z.string().uuid().optional(),
  serviceName: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000),
  basePrice: z.number().finite().nonnegative().max(1_000_000),
  duration: z.string().trim().min(1).max(80),
  category: z.nativeEnum(ServiceCategory),
  onlineBookingEnabled: z.boolean(),
  addOns: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    price: z.number().finite().nonnegative().max(1_000_000),
  }).strict()).max(50).optional(),
}).strict();

const saveOnboardingServicesSchema = z.object({
  services: z.array(onboardingServiceSchema).min(1).max(100),
  booking: z.object({
    enabled: z.boolean(),
    bookingFormId: z.string().uuid().nullable().optional(),
    showNavigation: z.boolean(),
    showHeaderCta: z.boolean(),
    showServiceCtas: z.boolean(),
    showHomeCta: z.boolean(),
    showAvailableSlots: z.boolean(),
    showPrices: z.boolean(),
    showStartingPrices: z.boolean(),
    showServiceDuration: z.boolean(),
    ctaLabel: z.string().trim().min(1).max(80),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const names = new Set<string>();
  const serviceIds = new Set<string>();
  value.services.forEach((service, index) => {
    const key = service.serviceName.toLocaleLowerCase("en-GB");
    if (names.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["services", index, "serviceName"], message: "Duplicate service name" });
    }
    names.add(key);
    if (service.serviceCatalogId) {
      if (serviceIds.has(service.serviceCatalogId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["services", index, "serviceCatalogId"], message: "Duplicate service id" });
      }
      serviceIds.add(service.serviceCatalogId);
    }
  });
  if (value.booking.enabled && !value.services.some((service) => service.onlineBookingEnabled)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["services"], message: "Enable online booking for at least one selected service" });
  }
});

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
  saveOnboardingServices: saveOnboardingServicesSchema,
};
