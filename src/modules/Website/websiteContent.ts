import status from "http-status";
import { z } from "zod";
import AppError from "../../errorHelper/AppError";

const trimmedText = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => trimmedText(max).optional();
const nullableUrl = z.string().trim().url().max(2048).nullable().optional();
const optionalHttpsUrl = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().url().max(2048).refine((value) => value.toLowerCase().startsWith("https://"), {
    message: "Social links must use HTTPS",
  }).optional(),
);

const featureItemSchema = z.object({
  title: trimmedText(120),
  description: trimmedText(500),
}).strip();

const socialLinksSchema = z.object({
  facebook: optionalHttpsUrl,
  instagram: optionalHttpsUrl,
  linkedin: optionalHttpsUrl,
  youtube: optionalHttpsUrl,
  x: optionalHttpsUrl,
  tiktok: optionalHttpsUrl,
}).strip().optional();

/**
 * Structured presentation contracts for Website Studio.
 *
 * IMPORTANT: CRM-owned entities (services, reviews, booking forms, business
 * contact details) are deliberately not accepted in these page JSON schemas.
 * The public projection reads those from ServiceCatalog / Review / BookingForm /
 * AdminProfile at render time. WebsitePage.content is presentation copy only.
 */
const homeContentSchema = z.object({
  eyebrow: optionalText(120),
  heroTitle: optionalText(180),
  heroSubtitle: optionalText(600),
  heroImageUrl: nullableUrl,
  heroImageAlt: optionalText(240),
  announcement: optionalText(240),
  howItWorksHeading: optionalText(180),
  howItWorksIntro: optionalText(600),
  howItWorksSteps: z.array(featureItemSchema).max(6).optional(),
  primaryCtaLabel: optionalText(80),
  secondaryCtaLabel: optionalText(80),

  servicesHeading: optionalText(180),
  servicesIntro: optionalText(600),

  // Legacy aboutHeading/aboutBody remain supported and are now the editable
  // home-page About/Why-us copy shared by all templates.
  aboutHeading: optionalText(180),
  aboutBody: optionalText(1200),
  whyHeading: optionalText(180),
  whyIntro: optionalText(800),
  whyItems: z.array(featureItemSchema).max(6).optional(),

  reviewsHeading: optionalText(180),
  reviewsIntro: optionalText(600),
  areasHeading: optionalText(180),

  contactHeading: optionalText(180),
  contactBody: optionalText(800),
  finalCtaHeading: optionalText(180),

  // Site-wide presentation copy is kept in the HOME page so it is included in
  // the same immutable published snapshot without introducing a second content
  // store. CRM contact details still come from AdminProfile.
  footerDescription: optionalText(900),
  footerTrustText: optionalText(240),
  socialLinks: socialLinksSchema,
}).strip();

const aboutContentSchema = z.object({
  eyebrow: optionalText(120),
  heading: optionalText(180),
  body: optionalText(5000),
  imageUrl: nullableUrl,
  imageAlt: optionalText(240),
  values: z.array(trimmedText(140)).max(8).optional(),
  yearsExperience: z.number().int().min(0).max(200).nullable().optional(),
}).strip();

const servicesContentSchema = z.object({
  eyebrow: optionalText(120),
  heading: optionalText(180),
  intro: optionalText(1200),
  // Any legacy `services` / `items` arrays are stripped. Service cards always
  // come from ServiceCatalog in the public projection.
}).strip();

const reviewsContentSchema = z.object({
  eyebrow: optionalText(120),
  heading: optionalText(180),
  intro: optionalText(1200),
  // Any legacy testimonial arrays are stripped. Testimonials always come from
  // moderated CRM Review rows.
}).strip();

const contactContentSchema = z.object({
  eyebrow: optionalText(120),
  heading: optionalText(180),
  intro: optionalText(1200),
  // phone/email/address/openingHours are intentionally stripped. AdminProfile
  // is the canonical source for public contact details.
}).strip();

const bookingContentSchema = z.object({
  eyebrow: optionalText(120),
  heading: optionalText(180),
  intro: optionalText(1200),
  // Form fields, services, pricing and availability are never page content;
  // the public booking route resolves the selected published BookingForm.
}).strip();

const genericContentSchema = z.record(z.string(), z.unknown());
const MAX_PAGE_CONTENT_BYTES = 32 * 1024;

const schemaForKind = (kind: string) => {
  switch (kind) {
    case "HOME": return homeContentSchema;
    case "ABOUT": return aboutContentSchema;
    case "SERVICES": return servicesContentSchema;
    case "REVIEWS": return reviewsContentSchema;
    case "CONTACT": return contactContentSchema;
    case "BOOK":
    case "ESTIMATE": return bookingContentSchema;
    default: return genericContentSchema;
  }
};

const assertReasonablePayloadSize = (content: Record<string, unknown>) => {
  const size = Buffer.byteLength(JSON.stringify(content), "utf8");
  if (size > MAX_PAGE_CONTENT_BYTES) {
    throw new AppError(status.BAD_REQUEST, "Website page content is too large", {
      code: "WEBSITE_CONTENT_TOO_LARGE",
      retryable: false,
    });
  }
};

/**
 * WebsitePage.content is JSON in Prisma, so validation belongs at the service
 * boundary where the page kind is known. Known system pages are sanitized to
 * presentation-only fields; CUSTOM pages remain intentionally extensible.
 */
export const validateWebsitePageContent = (
  kind: string,
  content: unknown,
): Record<string, unknown> => {
  const parsed = genericContentSchema.safeParse(content ?? {});
  if (!parsed.success) {
    throw new AppError(status.BAD_REQUEST, "Website page content must be an object", {
      code: "WEBSITE_CONTENT_INVALID",
      retryable: false,
    });
  }

  assertReasonablePayloadSize(parsed.data);
  const structured = schemaForKind(kind).safeParse(parsed.data);
  if (!structured.success) {
    const issue = structured.error.issues[0];
    throw new AppError(status.BAD_REQUEST, issue?.message || "Website page content is invalid", {
      code: "WEBSITE_CONTENT_INVALID",
      retryable: false,
    });
  }
  return structured.data as Record<string, unknown>;
};
