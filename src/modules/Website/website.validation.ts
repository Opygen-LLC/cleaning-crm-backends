import { WEBSITE_EDITOR_SURFACES } from "./website.interface";
import { z } from "zod";

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex color");
const nullableText = (max: number) => z.string().trim().max(max).nullable();
const pageContent = z.record(z.string(), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 32 * 1024, "Website page content is too large");

const editorSurfaceQuery = z.object({
  surface: z.enum(WEBSITE_EDITOR_SURFACES).default("content"),
}).passthrough();

const createWebsite = z.object({
  subdomain: z.string().trim().min(3).max(63),
  templateId: z.string().trim().min(1).max(80).optional(),
  templateVersion: z.string().trim().min(1).max(32).optional(),
  primaryBookingFormId: z.string().uuid().nullable().optional(),
  primaryEstimateFormId: z.string().uuid().nullable().optional(),
}).strict();

const websitePatch = z.object({
  templateId: z.string().trim().min(1).max(80).optional(),
  templateVersion: z.string().trim().min(1).max(32).optional(),
  primaryColor: color.optional(),
  secondaryColor: color.optional(),
  accentColor: color.optional(),
  font: nullableText(80).optional(),
  logo: z.string().url().max(2048).nullable().optional(),
  favicon: z.string().url().max(2048).nullable().optional(),
  primaryBookingFormId: z.string().uuid().nullable().optional(),
  primaryEstimateFormId: z.string().uuid().nullable().optional(),
  bookingEnabled: z.boolean().optional(),
  bookingShowNavigation: z.boolean().optional(),
  bookingShowHeaderCta: z.boolean().optional(),
  bookingShowServiceCtas: z.boolean().optional(),
  bookingShowHomeCta: z.boolean().optional(),
  bookingShowAvailableSlots: z.boolean().optional(),
  bookingShowPrices: z.boolean().optional(),
  bookingShowStartingPrices: z.boolean().optional(),
  bookingShowServiceDuration: z.boolean().optional(),
  bookingCtaLabel: z.string().trim().min(1).max(40).optional(),
  estimateEnabled: z.boolean().optional(),
  metaTitle: nullableText(120).optional(),
  metaDescription: nullableText(320).optional(),
  socialImageUrl: z.string().url().max(2048).nullable().optional(),
  indexSite: z.boolean().optional(),
}).strict();

const updateWebsite = websitePatch;

const pagePatch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  content: pageContent.optional(),
  seoTitle: nullableText(120).optional(),
  seoDescription: nullableText(320).optional(),
  showInNavigation: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
}).strict();

const updatePage = pagePatch;

const saveDraft = z.object({
  expectedRevisionNumber: z.number().int().min(0).optional(),
  website: websitePatch.optional(),
  pages: z.array(pagePatch.extend({ id: z.string().uuid() })).max(50).optional(),
}).strict().refine(
  (value) => Boolean(value.website && Object.keys(value.website).length) || Boolean(value.pages?.length),
  "Draft contains no changes",
);

const publishWebsite = z.object({
  expectedRevisionNumber: z.number().int().min(0).optional(),
}).strict().default({});

const restoreRevision = z.object({
  expectedRevisionNumber: z.number().int().min(0).optional(),
}).strict().default({});


const brandUploadSignature = z.object({
  kind: z.enum(["logo", "favicon", "social"]),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]),
  bytes: z.number().int().positive().max(5 * 1024 * 1024),
}).strict();

const brandUploadFinalize = z.object({
  kind: z.enum(["logo", "favicon", "social"]),
  publicId: z.string().trim().min(1).max(512),
}).strict();

const createAsset = z.object({
  publicId: z.string().trim().min(1).max(255),
  url: z.string().url().max(2048),
  mimeType: z.string().trim().regex(/^image\/[a-z0-9.+-]+$/i, "Website assets must be images"),
  width: z.number().int().positive().max(20000).nullable().optional(),
  height: z.number().int().positive().max(20000).nullable().optional(),
  bytes: z.number().int().positive().max(50 * 1024 * 1024).nullable().optional(),
  altText: nullableText(300).optional(),
  folder: z.string().trim().regex(/^website\/[a-z0-9/_-]+$/i, "Use a website/* asset folder").max(160),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const addDomain = z.object({ domain: z.string().trim().min(3).max(253) }).strict();
const renameSubdomain = z.object({ subdomain: z.string().trim().min(3).max(63) }).strict();

const publicAnalyticsMetadata = z
  .record(z.string().trim().min(1).max(80), z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 20, "Too many analytics metadata fields");

const publicAnalytics = z.object({
  eventType: z.literal("PAGE_VIEW"),
  path: z.string().trim().min(1).max(500).regex(/^\//, "Path must be relative to the website"),
  sessionId: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/, "Invalid session id").optional(),
  referrer: z.string().trim().url().max(2048).optional(),
  utmSource: z.string().trim().max(120).optional(),
  utmMedium: z.string().trim().max(120).optional(),
  utmCampaign: z.string().trim().max(160).optional(),
  metadata: publicAnalyticsMetadata.optional(),
}).strict();

const publicClientError = z.object({
  message: z.string().trim().min(1).max(1000),
  digest: z.string().trim().max(240).regex(/^[A-Za-z0-9._:-]+$/, "Invalid error digest").optional(),
  path: z.string().trim().max(800).regex(/^\//, "Path must be relative to the website").optional(),
}).strict();
const configureWebsiteBooking = z.object({
  enabled: z.boolean(),
  bookingFormId: z.string().uuid().nullable().optional(),
  showNavigation: z.boolean().optional(),
  showHeaderCta: z.boolean().optional(),
  showServiceCtas: z.boolean().optional(),
  showHomeCta: z.boolean().optional(),
  showAvailableSlots: z.boolean().optional(),
  showPrices: z.boolean().optional(),
  showStartingPrices: z.boolean().optional(),
  showServiceDuration: z.boolean().optional(),
  ctaLabel: z.string().trim().min(1).max(40).optional(),
}).strict();

const publicContact = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  email: z.string().trim().toLowerCase().email("Invalid email address").max(254),
  phone: z.string().trim()
    .regex(/^[+\d\s()\-.]{7,40}$/, "Enter a valid phone number")
    .refine((value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 7 && digits.length <= 20;
    }, "Enter a valid phone number")
    .optional(),
  message: z.string().trim().min(10, "Please provide a little more detail").max(3000),
  serviceCatalogId: z.string().uuid().optional(),
  companyWebsite: z.string().trim().max(500).optional(),
}).strict();

export const websiteValidation = {
  editorSurfaceQuery,
  createWebsite,
  updateWebsite,
  updatePage,
  saveDraft,
  publishWebsite,
  restoreRevision,
  createAsset,
  brandUploadSignature,
  brandUploadFinalize,
  addDomain,
  renameSubdomain,
  configureWebsiteBooking,
  publicContact,
  publicAnalytics,
  publicClientError,
};
