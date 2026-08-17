import status from "http-status";
import { z } from "zod";
import AppError from "../../errorHelper/AppError";

const trimmedText = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => trimmedText(max).optional();
const nullableUrl = z.string().trim().url().max(2048).nullable().optional();

/**
 * Structured content contracts for the pages edited in Website Studio.
 * They deliberately preserve a few legacy keys (for example eyebrow/aboutBody)
 * so existing sites can move forward without a destructive content migration.
 */
const homeContentSchema = z.object({
  eyebrow: optionalText(120),
  heroTitle: optionalText(180),
  heroSubtitle: optionalText(600),
  primaryCtaLabel: optionalText(80),
  secondaryCtaLabel: optionalText(80),
  servicesHeading: optionalText(180),
  aboutHeading: optionalText(180),
  aboutBody: optionalText(1200),
  reviewsHeading: optionalText(180),
  areasHeading: optionalText(180),
  finalCtaHeading: optionalText(180),
}).passthrough();

const aboutContentSchema = z.object({
  eyebrow: optionalText(120),
  heading: optionalText(180),
  body: optionalText(5000),
  imageUrl: nullableUrl,
  imageAlt: optionalText(240),
  values: z.array(trimmedText(140)).max(8).optional(),
  yearsExperience: z.number().int().min(0).max(200).nullable().optional(),
}).passthrough();

const contactContentSchema = z.object({
  eyebrow: optionalText(120),
  heading: optionalText(180),
  intro: optionalText(1200),
  // Legacy phone/email/address/openingHours keys are stripped on the next
  // draft save. Existing published snapshots remain readable, while the public
  // renderer ignores those legacy values and uses AdminProfile exclusively.
}).strip();

const genericContentSchema = z.record(z.string(), z.unknown());
const MAX_PAGE_CONTENT_BYTES = 32 * 1024;

const schemaForKind = (kind: string) => {
  switch (kind) {
    case "HOME": return homeContentSchema;
    case "ABOUT": return aboutContentSchema;
    case "CONTACT": return contactContentSchema;
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
 * WebsitePage.content is JSON in Prisma, so validation must happen at the
 * service boundary where the page kind is known. This keeps the editor
 * structured while remaining backwards compatible with older templates.
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
