/** Wire contract v2. Backend validation is Zod 4; the frontend owns an
 * independent Zod 3 parser. No runtime schema is shared between applications.
 */
import { z } from "zod";
import { Currency, ServiceCategory } from "../../generated/prisma/enums";
import { e164PhoneSchema } from "../../lib/validation/phone";
import { businessHoursSchema } from "./businessHours";

export const ONBOARDING_SAVE_SCHEMA_VERSION = 2 as const;
const version = z.string().regex(/^[0-9a-f]{64}$/);
const base = {
  schemaVersion: z.literal(ONBOARDING_SAVE_SCHEMA_VERSION),
  websiteId: z.string().uuid(),
  expectedRevisionNumber: z.number().int().nonnegative(),
};
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
export const onboardingProfilePatchSchema = z.object({
  businessName: z.string().trim().min(1).max(160).optional(),
  businessEmail: z.string().trim().email().max(320).nullable().optional(),
  mobileNumber: e164PhoneSchema().nullable().optional(),
  businessDescription: optionalText(1000),
  businessHours: businessHoursSchema.nullable().optional(),
  address: optionalText(300),
  city: z.string().trim().min(1).max(120).nullable().optional(),
  postcode: optionalText(32),
  zipcode: optionalText(32),
  currency: z.enum(Currency).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.postcode !== undefined && value.zipcode !== undefined && value.postcode !== value.zipcode) {
    ctx.addIssue({ code: "custom", path: ["postcode"], message: "postcode conflicts with legacy zipcode" });
  }
});
const color = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a 6-digit hex color");
export const onboardingBrandingPatchSchema = z.object({
  primaryColor: color.optional(), secondaryColor: color.optional(), accentColor: color.optional(),
  font: z.string().trim().min(1).max(80).nullable().optional(),
  logo: z.string().url().max(2048).nullable().optional(),
  favicon: z.string().url().max(2048).nullable().optional(),
}).strict();
const serviceSchema = z.object({
  serviceCatalogId: z.string().uuid().optional(),
  serviceName: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000),
  basePrice: z.number().finite().nonnegative().max(1_000_000),
  duration: z.string().trim().min(1).max(80),
  category: z.enum(ServiceCategory),
  onlineBookingEnabled: z.boolean(),
  // Omitted means keep existing; [] is an explicit clear.
  addOns: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    price: z.number().finite().nonnegative().max(1_000_000),
  }).strict()).max(50).optional(),
}).strict();
const bookingSchema = z.object({
  enabled: z.boolean(), bookingFormId: z.string().uuid().nullable().optional(),
  showNavigation: z.boolean(), showHeaderCta: z.boolean(), showServiceCtas: z.boolean(),
  showHomeCta: z.boolean(), showAvailableSlots: z.boolean(), showPrices: z.boolean(),
  showStartingPrices: z.boolean(), showServiceDuration: z.boolean(),
  ctaLabel: z.string().trim().min(1).max(40),
}).strict();

export const onboardingServicesSaveSchema = z.object({
  ...base, step: z.literal("services"), catalogVersion: version,
  // This is a change set, NOT the selected set and NOT a catalog replacement.
  services: z.array(serviceSchema).max(2000),
  deactivateServiceCatalogIds: z.array(z.string().uuid()).max(2000),
  booking: bookingSchema,
}).strict();

export const onboardingStepSaveSchema = z.discriminatedUnion("step", [
  z.object({ ...base, step: z.literal("business_profile"), expectedProfileVersion: version, profile: onboardingProfilePatchSchema }).strict(),
  z.object({ ...base, step: z.literal("branding"), branding: onboardingBrandingPatchSchema }).strict(),
  onboardingServicesSaveSchema,
  z.object({ ...base, step: z.literal("website_address"), subdomain: z.string().trim().min(3).max(63) }).strict(),
]);
export type OnboardingStepSavePayload = z.infer<typeof onboardingStepSaveSchema>;
export type OnboardingBrandingPatch = z.infer<typeof onboardingBrandingPatchSchema>;
