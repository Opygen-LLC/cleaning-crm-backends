import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MediaPurpose } from "./media.types";
import { MEDIA_PURPOSE_POLICY } from "./media.policy";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/heic-sequence": "heic",
  "image/heif-sequence": "heif",
  "application/pdf": "pdf",
};

const safeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "");

export const extensionForMime = (mimeType: string): string =>
  EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? "bin";

export const buildTemporaryObjectKey = (adminId: string, uploadId: string, contentType: string): string =>
  `tmp/${safeSegment(adminId)}/${safeSegment(uploadId)}/source.${extensionForMime(contentType)}`;

export const buildFinalObjectKey = (params: {
  adminId: string;
  purpose: MediaPurpose;
  entityId?: string | null;
  mimeType: string;
  objectId?: string;
}): string => {
  const policy = MEDIA_PURPOSE_POLICY[params.purpose];
  const parts = ["organizations", safeSegment(params.adminId), policy.prefix];
  if (params.entityId) parts.push(safeSegment(params.entityId));

  if (params.purpose === "WEBSITE_BRAND") parts.push("brand");
  if (params.purpose === "WEBSITE_CONTENT") parts.push("content");
  if (params.purpose === "JOB_PHOTO") parts.push("photos");
  if (params.purpose === "JOB_ATTACHMENT") parts.push("attachments");
  if (params.purpose === "PAYMENT_PROOF" || params.purpose === "SUBSCRIPTION_PROOF") parts.push("proofs");
  if (params.purpose === "PAYMENT_RECEIPT") parts.push("receipts");
  if (params.purpose === "INVOICE_ATTACHMENT") parts.push("attachments");
  if (params.purpose === "EXPENSE_RECEIPT") parts.push("receipts");

  const objectId = params.objectId ? safeSegment(params.objectId) : randomUUID();
  return path.posix.join(...parts, `${objectId}.${extensionForMime(params.mimeType)}`);
};
