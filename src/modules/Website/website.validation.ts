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
  website: websitePatch.optional(),
  pages: z.array(pagePatch.extend({ id: z.string().uuid() })).max(50).optional(),
}).strict().refine(
  (value) => Boolean(value.website && Object.keys(value.website).length) || Boolean(value.pages?.length),
  "Draft contains no changes",
);

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

export const websiteValidation = { createWebsite, updateWebsite, updatePage, saveDraft, createAsset, addDomain, renameSubdomain };
