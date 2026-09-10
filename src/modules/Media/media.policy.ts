import type { MediaPurpose, MediaPurposePolicy } from "./media.types";

const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
] as const;

const IMAGE_OR_PDF = [...IMAGE_MIME_TYPES, "application/pdf"] as const;

export const MEDIA_PURPOSE_POLICY: Record<MediaPurpose, MediaPurposePolicy> = {
  USER_AVATAR: {
    visibility: "PUBLIC", prefix: "profiles/users", entityType: "USER", requireEntity: false,
    allowedMimeTypes: IMAGE_MIME_TYPES, maxDimension: 512, targetBytes: 100 * 1024, imageOnly: true,
  },
  STAFF_AVATAR: {
    visibility: "PUBLIC", prefix: "profiles/staff", entityType: "STAFF", requireEntity: true,
    allowedMimeTypes: IMAGE_MIME_TYPES, maxDimension: 512, targetBytes: 100 * 1024, imageOnly: true,
  },
  BUSINESS_LOGO: {
    visibility: "PUBLIC", prefix: "branding/logo", entityType: "BUSINESS", requireEntity: false,
    allowedMimeTypes: IMAGE_MIME_TYPES, maxDimension: 1024, targetBytes: 150 * 1024, imageOnly: true,
  },
  BUSINESS_FAVICON: {
    visibility: "PUBLIC", prefix: "branding/favicon", entityType: "BUSINESS", requireEntity: false,
    allowedMimeTypes: IMAGE_MIME_TYPES, maxDimension: 512, targetBytes: 80 * 1024, imageOnly: true,
  },
  SERVICE_IMAGE: {
    visibility: "PUBLIC", prefix: "services", entityType: "SERVICE", requireEntity: true,
    allowedMimeTypes: IMAGE_MIME_TYPES, maxDimension: 1600, targetBytes: 250 * 1024, imageOnly: true,
  },
  WEBSITE_BRAND: {
    visibility: "PUBLIC", prefix: "website", entityType: "WEBSITE", requireEntity: true,
    allowedMimeTypes: IMAGE_MIME_TYPES, maxDimension: 1600, targetBytes: 250 * 1024, imageOnly: true,
  },
  WEBSITE_CONTENT: {
    visibility: "PUBLIC", prefix: "website", entityType: "WEBSITE", requireEntity: true,
    allowedMimeTypes: IMAGE_MIME_TYPES, maxDimension: 2000, targetBytes: 400 * 1024, imageOnly: true,
  },
  JOB_PHOTO: {
    visibility: "PRIVATE", prefix: "jobs", entityType: "JOB", requireEntity: true,
    allowedMimeTypes: IMAGE_MIME_TYPES, maxDimension: 2000, targetBytes: 500 * 1024, imageOnly: true,
  },
  JOB_ATTACHMENT: {
    visibility: "PRIVATE", prefix: "jobs", entityType: "JOB", requireEntity: true,
    allowedMimeTypes: IMAGE_OR_PDF, maxDimension: 2000, targetBytes: 500 * 1024, imageOnly: false,
  },
  PAYMENT_PROOF: {
    visibility: "PRIVATE", prefix: "payments", entityType: "PAYMENT", requireEntity: false,
    allowedMimeTypes: IMAGE_OR_PDF, maxDimension: 1600, targetBytes: 300 * 1024, imageOnly: false,
  },
  INVOICE_ATTACHMENT: {
    visibility: "PRIVATE", prefix: "invoices", entityType: "INVOICE", requireEntity: true,
    allowedMimeTypes: IMAGE_OR_PDF, maxDimension: 1600, targetBytes: 300 * 1024, imageOnly: false,
  },
  EXPENSE_RECEIPT: {
    visibility: "PRIVATE", prefix: "expenses", entityType: "EXPENSE", requireEntity: false,
    allowedMimeTypes: IMAGE_OR_PDF, maxDimension: 1600, targetBytes: 300 * 1024, imageOnly: false,
  },
  SUBSCRIPTION_PROOF: {
    visibility: "PRIVATE", prefix: "subscriptions", entityType: "SUBSCRIPTION", requireEntity: false,
    allowedMimeTypes: IMAGE_OR_PDF, maxDimension: 1600, targetBytes: 300 * 1024, imageOnly: false,
  },
};

export const isImageMimeType = (mimeType: string): boolean =>
  mimeType.toLowerCase().startsWith("image/");
