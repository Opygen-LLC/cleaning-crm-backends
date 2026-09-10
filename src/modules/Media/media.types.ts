export const MEDIA_PURPOSES = [
  "USER_AVATAR",
  "STAFF_AVATAR",
  "BUSINESS_LOGO",
  "BUSINESS_FAVICON",
  "SERVICE_IMAGE",
  "WEBSITE_BRAND",
  "WEBSITE_CONTENT",
  "JOB_PHOTO",
  "JOB_ATTACHMENT",
  "PAYMENT_PROOF",
  "INVOICE_ATTACHMENT",
  "EXPENSE_RECEIPT",
  "SUBSCRIPTION_PROOF",
] as const;

export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];
export type MediaVisibility = "PUBLIC" | "PRIVATE";
export type MediaStatus = "INITIATED" | "PROCESSING" | "READY" | "FAILED" | "DELETED";

export interface MediaPurposePolicy {
  visibility: MediaVisibility;
  prefix: string;
  entityType: string;
  requireEntity: boolean;
  allowedMimeTypes: readonly string[];
  maxDimension?: number;
  targetBytes?: number;
  imageOnly: boolean;
}

export interface InitiateMediaUploadInput {
  purpose: MediaPurpose;
  entityId?: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ServerMediaUploadInput {
  purpose: MediaPurpose;
  entityId?: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
}
