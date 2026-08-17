import { z } from "zod";

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex color");
const nullableText = (max: number) => z.string().trim().max(max).nullable();

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
  metaTitle: nullableText(120).optional(),
  metaDescription: nullableText(320).optional(),
  socialImageUrl: z.string().url().max(2048).nullable().optional(),
  indexSite: z.boolean().optional(),
}).strict();

const updateWebsite = websitePatch;

const pagePatch = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
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

const publicAnalytics = z.object({
  eventType: z.literal("PAGE_VIEW"),
  path: z.string().trim().min(1).max(500),
  sessionId: z.string().trim().max(160).optional(),
  referrer: z.string().trim().max(2048).optional(),
  utmSource: z.string().trim().max(120).optional(),
  utmMedium: z.string().trim().max(120).optional(),
  utmCampaign: z.string().trim().max(160).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).strict();

const publicClientError = z.object({
  message: z.string().trim().min(1).max(1000),
  digest: z.string().trim().max(240).optional(),
  path: z.string().trim().max(800).optional(),
}).strict();
const publicContact = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email("Invalid email address").max(320),
  phone: z.string().trim().max(80).optional(),
  message: z.string().trim().min(1, "Message is required").max(5000),
  serviceCatalogId: z.string().uuid().optional(),
  companyWebsite: z.string().trim().max(500).optional(),
}).strict();

export const websiteValidation = {
  createWebsite,
  updateWebsite,
  updatePage,
  saveDraft,
  publishWebsite,
  createAsset,
  addDomain,
  renameSubdomain,
  publicContact,
  publicAnalytics,
  publicClientError,
};
