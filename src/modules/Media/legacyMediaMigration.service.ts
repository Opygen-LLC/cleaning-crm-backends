import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { R2_MAX_DOCUMENT_SIZE_MB, R2_MAX_IMAGE_SIZE_MB } from "../../config/ENV";
import { r2StorageService } from "../../lib/storage/r2Storage.service";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { mediaService } from "./media.service";
import { MEDIA_PURPOSE_POLICY, isImageMimeType } from "./media.policy";
import type { MediaPurpose } from "./media.types";

const LEGACY_HOST = /(^|\.)cloudinary\.com$/i;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 100;
const NOTE_RECEIPT_PATTERN = /\[RECEIPT:(https:\/\/[^\]\s]+)\]/i;
const EMBEDDED_HTTPS_URL_PATTERN = /https:\/\/[^\s"'<>\)\]]+/g;

class LegacySourceMissingError extends Error {}
class LegacySourceInvalidError extends Error {}

type MigrationStatus = "MIGRATED" | "FAILED" | "MISSING" | "INVALID" | "SKIPPED";

type MigrationCounters = {
  discovered: number;
  migrated: number;
  reused: number;
  skipped: number;
  failed: number;
  missing: number;
  invalid: number;
  websitesInvalidated: number;
};

export interface LegacyMediaMigrationOptions {
  dryRun?: boolean;
  verifyOnly?: boolean;
  adminId?: string;
}

export interface LegacyMediaMigrationReport {
  mode: "dry-run" | "verify" | "migrate";
  startedAt: string;
  finishedAt: string;
  counters: MigrationCounters;
  remainingLegacyReferences: number;
  r2VerificationFailures: number;
  notes: string[];
}

type MigratedAsset = Awaited<ReturnType<typeof mediaService.uploadFromServerForTenant>>;

const emptyCounters = (): MigrationCounters => ({
  discovered: 0,
  migrated: 0,
  reused: 0,
  skipped: 0,
  failed: 0,
  missing: 0,
  invalid: 0,
  websitesInvalidated: 0,
});

export const isLegacyMediaUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && LEGACY_HOST.test(url.hostname);
  } catch {
    return false;
  }
};

const migrationHash = (input: { url: string; purpose: MediaPurpose; entityType?: string; entityId?: string }) =>
  createHash("sha256")
    .update([input.url, input.purpose, input.entityType ?? "", input.entityId ?? ""].join("\0"))
    .digest("hex");

const stableObjectId = (hash: string) => `legacy-${hash.slice(0, 32)}`;

const safeFilename = (url: string, mimeType: string) => {
  let name = "legacy-media";
  try {
    name = decodeURIComponent(basename(new URL(url).pathname)) || name;
  } catch { /* URL was already validated by the caller. */ }
  name = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "legacy-media";
  if (!name.includes(".")) {
    const ext = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : mimeType === "image/avif" ? "avif" : "jpg";
    name = `${name}.${ext}`;
  }
  return name;
};

const detectedMimeType = (buffer: Buffer, headerContentType?: string | null) => {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    if (["avif", "avis"].includes(brand)) return "image/avif";
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
  const normalized = headerContentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized && (normalized.startsWith("image/") || normalized === "application/pdf")) return normalized;
  throw new LegacySourceInvalidError("The legacy object has an unsupported or unrecognizable file signature.");
};

const assertLegacyUrl = (value: string) => {
  if (!isLegacyMediaUrl(value)) throw new LegacySourceInvalidError("Only HTTPS legacy media delivery URLs are allowed as migration sources.");
  return new URL(value);
};

const fetchLegacyObject = async (sourceUrl: string, purpose: MediaPurpose) => {
  const policy = MEDIA_PURPOSE_POLICY[purpose];
  const maxBytes = Math.max(R2_MAX_IMAGE_SIZE_MB, R2_MAX_DOCUMENT_SIZE_MB) * 1024 * 1024;
  let current = assertLegacyUrl(sourceUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirectCount === MAX_REDIRECTS) throw new LegacySourceInvalidError("Legacy media redirect limit exceeded.");
      current = assertLegacyUrl(new URL(location, current).toString());
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      throw new LegacySourceMissingError(`Legacy media returned HTTP ${response.status}.`);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Legacy media download failed with HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new LegacySourceInvalidError(`Legacy media exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB migration limit.`);
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LegacySourceInvalidError(`Legacy media exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB migration limit.`);
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) throw new LegacySourceInvalidError("Legacy media is empty.");
    const buffer = Buffer.concat(chunks, total);
    const mimeType = detectedMimeType(buffer, response.headers.get("content-type"));
    if (!policy.allowedMimeTypes.includes(mimeType)) {
      throw new LegacySourceInvalidError(`Detected file type ${mimeType} is not allowed for ${purpose}.`);
    }
    if (policy.imageOnly && !isImageMimeType(mimeType)) {
      throw new LegacySourceInvalidError(`${purpose} requires an image.`);
    }
    return { buffer, mimeType, filename: safeFilename(sourceUrl, mimeType) };
  }
  throw new LegacySourceInvalidError("Legacy media redirect loop detected.");
};

const migrationMetadata = (input: { source: string; entityType?: string; entityId?: string }) => ({
  sourceField: input.source,
  entityType: input.entityType ?? null,
  entityId: input.entityId ?? null,
  migrationVersion: 3,
});

const markFailure = async (id: string, error: unknown): Promise<MigrationStatus> => {
  const status: MigrationStatus = error instanceof LegacySourceMissingError ? "MISSING" : error instanceof LegacySourceInvalidError ? "INVALID" : "FAILED";
  const message = error instanceof Error ? error.message : String(error);
  await prisma.legacyMediaMigration.update({
    where: { id },
    data: { status, lastError: message.slice(0, 4000) },
  }).catch(() => undefined);
  return status;
};

const migrateSource = async (input: {
  adminId: string;
  sourceUrl: string;
  purpose: MediaPurpose;
  entityType?: string;
  entityId?: string;
  sourceField: string;
  counters: MigrationCounters;
}): Promise<MigratedAsset | null> => {
  if (!isLegacyMediaUrl(input.sourceUrl)) return null;
  input.counters.discovered += 1;
  // The same legacy URL may legitimately be reused by multiple records. The
  // entity identity is part of the idempotency key so one user's avatar or
  // payment proof can never become another record's authoritative MediaAsset.
  const hash = migrationHash({
    url: input.sourceUrl,
    purpose: input.purpose,
    entityType: input.entityType,
    entityId: input.entityId,
  });
  const policy = MEDIA_PURPOSE_POLICY[input.purpose];
  const migration = await prisma.legacyMediaMigration.upsert({
    where: { adminId_sourceUrlHash_purpose: { adminId: input.adminId, sourceUrlHash: hash, purpose: input.purpose } },
    create: {
      adminId: input.adminId,
      sourceUrlHash: hash,
      sourceUrl: input.sourceUrl,
      purpose: input.purpose,
      visibility: policy.visibility,
      entityType: input.entityType ?? policy.entityType,
      entityId: input.entityId ?? null,
      metadata: migrationMetadata({ source: input.sourceField, entityType: input.entityType, entityId: input.entityId }),
    },
    update: {
      entityType: input.entityType ?? policy.entityType,
      entityId: input.entityId ?? null,
      metadata: migrationMetadata({ source: input.sourceField, entityType: input.entityType, entityId: input.entityId }),
    },
  });

  if (migration.status === "MIGRATED" && migration.targetMediaAssetId) {
    const existing = await prisma.mediaAsset.findFirst({ where: { id: migration.targetMediaAssetId, adminId: input.adminId, status: "READY", deletedAt: null } });
    if (existing) {
      input.counters.reused += 1;
      return existing;
    }
  }

  await prisma.legacyMediaMigration.update({
    where: { id: migration.id },
    data: { status: "PROCESSING", attemptCount: { increment: 1 }, lastError: null },
  });

  try {
    const downloaded = await fetchLegacyObject(input.sourceUrl, input.purpose);
    const asset = await mediaService.uploadFromServerForTenant({
      purpose: input.purpose,
      entityId: input.entityId,
      filename: downloaded.filename,
      contentType: downloaded.mimeType,
      buffer: downloaded.buffer,
      objectId: stableObjectId(hash),
    }, input.adminId, null);
    const verified = await r2StorageService.headObject(asset.bucket, asset.objectKey);
    if (!verified.ContentLength || (asset.storedBytes && verified.ContentLength !== asset.storedBytes)) {
      throw new Error("R2 verification failed after upload: stored byte size did not match the MediaAsset record.");
    }
    await prisma.legacyMediaMigration.update({
      where: { id: migration.id },
      data: { status: "MIGRATED", targetMediaAssetId: asset.id, migratedAt: new Date(), lastError: null },
    });
    input.counters.migrated += 1;
    return asset;
  } catch (error) {
    const status = await markFailure(migration.id, error);
    if (status === "MISSING") input.counters.missing += 1;
    else if (status === "INVALID") input.counters.invalid += 1;
    else input.counters.failed += 1;
    return null;
  }
};

const storageMarker = (assetId: string) => `r2-asset://${assetId}`;
const objectMarker = (asset: MigratedAsset) => `r2://${asset.bucket}/${asset.objectKey}`;

const sanitizeMetadata = (value: unknown, mediaAssetId?: string): Prisma.InputJsonValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { provider: "r2", ...(mediaAssetId ? { mediaAssetId } : {}) };
  }
  const out: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/cloudinary/i.test(key)) continue;
    if (key === "provider") { out.provider = "r2"; continue; }
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw as string | number | boolean | null;
    else if (Array.isArray(raw)) out[key] = raw as Prisma.InputJsonArray;
    else if (typeof raw === "object") out[key] = raw as Prisma.InputJsonObject;
  }
  out.provider = "r2";
  if (mediaAssetId) out.mediaAssetId = mediaAssetId;
  out.migratedFromLegacyStorage = true;
  return out as Prisma.InputJsonObject;
};

const legacyUrlsInString = (value: string): string[] => {
  const candidates = value.match(EMBEDDED_HTTPS_URL_PATTERN) ?? [];
  return candidates.filter(isLegacyMediaUrl);
};

const collectLegacyUrls = (value: unknown, output = new Set<string>()): Set<string> => {
  if (typeof value === "string") {
    for (const url of legacyUrlsInString(value)) output.add(url);
    return output;
  }
  if (Array.isArray(value)) for (const item of value) collectLegacyUrls(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) collectLegacyUrls(item, output);
  return output;
};

const replaceUrlsInJson = (value: unknown, replacements: Map<string, string>): { value: unknown; changed: boolean } => {
  if (typeof value === "string") {
    let changed = false;
    const next = value.replace(EMBEDDED_HTTPS_URL_PATTERN, (candidate) => {
      const replacement = replacements.get(candidate);
      if (!replacement) return candidate;
      changed = true;
      return replacement;
    });
    return { value: changed ? next : value, changed };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = replaceUrlsInJson(item, replacements);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = replaceUrlsInJson(item, replacements);
      next[key] = result.value;
      changed ||= result.changed;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
};

const scrubLegacyProviderMetadata = (value: unknown): { value: unknown; changed: boolean } => {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = scrubLegacyProviderMetadata(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/cloudinary/i.test(key)) { changed = true; continue; }
    if (key === "provider" && typeof item === "string" && item.toLowerCase() === "cloudinary") {
      next[key] = "r2";
      changed = true;
      continue;
    }
    const result = scrubLegacyProviderMetadata(item);
    next[key] = result.value;
    changed ||= result.changed;
  }
  return { value: changed ? next : value, changed };
};

const processInBatches = async <T extends { id: string }>(
  fetchPage: (cursor?: string) => Promise<T[]>,
  processRow: (row: T) => Promise<void>,
) => {
  let cursor: string | undefined;
  while (true) {
    const rows = await fetchPage(cursor);
    if (!rows.length) return;
    for (const row of rows) await processRow(row);
    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) return;
  }
};

const migrateUsers = async (options: LegacyMediaMigrationOptions, counters: MigrationCounters) => processInBatches(
  (cursor) => prisma.user.findMany({
    where: { image: { not: null }, ...(options.adminId ? { OR: [{ admin: { id: options.adminId } }, { staff: { adminId: options.adminId } }] } : {}) },
    orderBy: { id: "asc" }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, image: true, imageMediaAssetId: true, admin: { select: { id: true } }, staff: { select: { adminId: true } } },
  }),
  async (row) => {
    if (!isLegacyMediaUrl(row.image)) return;
    const adminId = row.admin?.id ?? row.staff?.adminId;
    if (!adminId) { counters.skipped += 1; return; }
    const asset = await migrateSource({ adminId, sourceUrl: row.image, purpose: "USER_AVATAR", entityId: row.id, entityType: "USER", sourceField: "User.image", counters });
    if (asset) await prisma.user.update({ where: { id: row.id }, data: { image: asset.publicUrl, imageMediaAssetId: asset.id } });
  },
);

const migrateAdminLogos = async (options: LegacyMediaMigrationOptions, counters: MigrationCounters) => processInBatches(
  (cursor) => prisma.adminProfile.findMany({
    where: { businessLogo: { not: null }, ...(options.adminId ? { id: options.adminId } : {}) },
    orderBy: { id: "asc" }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, businessLogo: true },
  }),
  async (row) => {
    if (!isLegacyMediaUrl(row.businessLogo)) return;
    const asset = await migrateSource({ adminId: row.id, sourceUrl: row.businessLogo, purpose: "BUSINESS_LOGO", entityType: "BUSINESS", sourceField: "AdminProfile.businessLogo", counters });
    if (asset) await prisma.adminProfile.update({ where: { id: row.id }, data: { businessLogo: asset.publicUrl, businessLogoMediaAssetId: asset.id } });
  },
);

const migrateJobAttachments = async (options: LegacyMediaMigrationOptions, counters: MigrationCounters) => processInBatches(
  (cursor) => prisma.jobAttachment.findMany({
    where: { fileUrl: { not: "" }, ...(options.adminId ? { adminId: options.adminId } : {}) },
    orderBy: { id: "asc" }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, adminId: true, jobId: true, fileUrl: true, mimeType: true },
  }),
  async (row) => {
    if (!isLegacyMediaUrl(row.fileUrl)) return;
    const purpose: MediaPurpose = row.mimeType.startsWith("image/") ? "JOB_PHOTO" : "JOB_ATTACHMENT";
    const asset = await migrateSource({ adminId: row.adminId, sourceUrl: row.fileUrl, purpose, entityId: row.jobId, entityType: "JOB", sourceField: "JobAttachment.fileUrl", counters });
    if (asset) await prisma.jobAttachment.update({ where: { id: row.id }, data: { fileUrl: objectMarker(asset), mediaAssetId: asset.id, storageKey: asset.objectKey, mimeType: asset.mimeType, fileSizeBytes: asset.storedBytes ?? asset.originalBytes } });
  },
);

const migratePayments = async (options: LegacyMediaMigrationOptions, counters: MigrationCounters) => processInBatches(
  (cursor) => prisma.payment.findMany({
    where: options.adminId ? { adminId: options.adminId } : {},
    orderBy: { id: "asc" }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, adminId: true, paymentProofUrl: true, invoiceUrl: true },
  }),
  async (row) => {
    if (isLegacyMediaUrl(row.paymentProofUrl)) {
      const asset = await migrateSource({ adminId: row.adminId, sourceUrl: row.paymentProofUrl, purpose: "PAYMENT_PROOF", entityId: row.id, entityType: "PAYMENT", sourceField: "Payment.paymentProofUrl", counters });
      if (asset) await prisma.payment.update({ where: { id: row.id }, data: { paymentProofUrl: storageMarker(asset.id), paymentProofMediaAssetId: asset.id } });
    }
    if (isLegacyMediaUrl(row.invoiceUrl)) {
      const asset = await migrateSource({ adminId: row.adminId, sourceUrl: row.invoiceUrl, purpose: "BILLING_INVOICE", entityId: row.id, entityType: "PAYMENT", sourceField: "Payment.invoiceUrl", counters });
      if (asset) await prisma.payment.update({ where: { id: row.id }, data: { invoiceUrl: storageMarker(asset.id), invoiceMediaAssetId: asset.id } });
    }
  },
);

const migrateBillingHistory = async (options: LegacyMediaMigrationOptions, counters: MigrationCounters) => processInBatches(
  (cursor) => prisma.billingHistory.findMany({
    where: options.adminId ? { subscription: { adminId: options.adminId } } : {},
    orderBy: { id: "asc" }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, paymentProofUrl: true, invoiceUrl: true, subscription: { select: { id: true, adminId: true } } },
  }),
  async (row) => {
    const adminId = row.subscription.adminId;
    if (isLegacyMediaUrl(row.paymentProofUrl)) {
      const asset = await migrateSource({ adminId, sourceUrl: row.paymentProofUrl, purpose: "SUBSCRIPTION_PROOF", entityId: row.subscription.id, entityType: "SUBSCRIPTION", sourceField: "BillingHistory.paymentProofUrl", counters });
      if (asset) await prisma.billingHistory.update({ where: { id: row.id }, data: { paymentProofUrl: storageMarker(asset.id), paymentProofMediaAssetId: asset.id } });
    }
    if (isLegacyMediaUrl(row.invoiceUrl)) {
      const asset = await migrateSource({ adminId, sourceUrl: row.invoiceUrl, purpose: "BILLING_INVOICE", entityId: row.id, entityType: "BILLING", sourceField: "BillingHistory.invoiceUrl", counters });
      if (asset) await prisma.billingHistory.update({ where: { id: row.id }, data: { invoiceUrl: storageMarker(asset.id), invoiceMediaAssetId: asset.id } });
    }
  },
);

const migrateExpenses = async (options: LegacyMediaMigrationOptions, counters: MigrationCounters) => processInBatches(
  (cursor) => prisma.expense.findMany({
    where: options.adminId ? { adminId: options.adminId } : {},
    orderBy: { id: "asc" }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, adminId: true, receiptUrl: true, notes: true },
  }),
  async (row) => {
    const noteMatch = row.notes?.match(NOTE_RECEIPT_PATTERN);
    const legacyUrl = isLegacyMediaUrl(row.receiptUrl) ? row.receiptUrl : (noteMatch && isLegacyMediaUrl(noteMatch[1]) ? noteMatch[1] : null);
    if (!legacyUrl) return;
    const asset = await migrateSource({ adminId: row.adminId, sourceUrl: legacyUrl, purpose: "EXPENSE_RECEIPT", entityId: row.id, entityType: "EXPENSE", sourceField: isLegacyMediaUrl(row.receiptUrl) ? "Expense.receiptUrl" : "Expense.notes[RECEIPT]", counters });
    if (!asset) return;
    const cleanedNotes = noteMatch ? (row.notes ?? "").replace(NOTE_RECEIPT_PATTERN, "").replace(/\n{3,}/g, "\n\n").trim() || null : row.notes;
    await prisma.expense.update({ where: { id: row.id }, data: { receiptUrl: storageMarker(asset.id), receiptMediaAssetId: asset.id, notes: cleanedNotes } });
  },
);

const ensureWebsiteAssetRow = async (input: {
  websiteId: string;
  sourceUrl: string;
  asset: MigratedAsset;
  kind: "brand" | "content";
  slot?: string;
}) => {
  const existing = await prisma.websiteAsset.findFirst({ where: { websiteId: input.websiteId, OR: [{ url: input.sourceUrl }, { mediaAssetId: input.asset.id }] } });
  const metadata = sanitizeMetadata(existing?.metadata, input.asset.id);
  const data = {
    publicId: input.asset.objectKey,
    mediaAssetId: input.asset.id,
    url: input.asset.publicUrl ?? input.sourceUrl,
    mimeType: input.asset.mimeType,
    width: input.asset.width,
    height: input.asset.height,
    bytes: input.asset.storedBytes ?? input.asset.originalBytes,
    folder: `website/${input.websiteId}/${input.kind}`,
    metadata: {
      ...(metadata as Prisma.InputJsonObject),
      kind: input.kind,
      ...(input.slot ? { slot: input.slot } : {}),
      immutable: true,
    } as Prisma.InputJsonValue,
  };
  if (existing) return prisma.websiteAsset.update({ where: { id: existing.id }, data });
  return prisma.websiteAsset.create({ data: { websiteId: input.websiteId, ...data } });
};

const migrateWebsites = async (options: LegacyMediaMigrationOptions, counters: MigrationCounters) => processInBatches(
  (cursor) => prisma.businessWebsite.findMany({
    where: options.adminId ? { adminId: options.adminId } : {},
    orderBy: { id: "asc" }, take: Math.min(25, BATCH_SIZE), ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, adminId: true, logo: true, favicon: true, socialImageUrl: true, websiteDesign: true, publishedDesignMetadata: true, publishedSnapshot: true },
  }),
  async (website) => {
    const replacements = new Map<string, string>();
    let changed = false;
    const assets = await prisma.websiteAsset.findMany({ where: { websiteId: website.id }, orderBy: { createdAt: "asc" } });

    for (const row of assets) {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
      let metadataValue: unknown = row.metadata;
      const brandSlot = row.url === website.logo ? "logo" : row.url === website.favicon ? "favicon" : row.url === website.socialImageUrl ? "social" : undefined;
      const purpose: MediaPurpose = metadata.kind === "brand" || brandSlot ? "WEBSITE_BRAND" : "WEBSITE_CONTENT";
      if (isLegacyMediaUrl(row.url)) {
        const asset = await migrateSource({ adminId: website.adminId, sourceUrl: row.url, purpose, entityId: website.id, entityType: "WEBSITE", sourceField: `WebsiteAsset.${row.id}.url`, counters });
        if (asset?.publicUrl) {
          replacements.set(row.url, asset.publicUrl);
          const migratedMetadata = {
            ...(sanitizeMetadata(row.metadata, asset.id) as Prisma.InputJsonObject),
            kind: brandSlot ? "brand" : (metadata.kind === "brand" ? "brand" : "content"),
            ...(brandSlot ? { slot: brandSlot } : {}),
          } as Prisma.InputJsonValue;
          await prisma.websiteAsset.update({
            where: { id: row.id },
            data: {
              publicId: asset.objectKey,
              mediaAssetId: asset.id,
              url: asset.publicUrl,
              mimeType: asset.mimeType,
              width: asset.width,
              height: asset.height,
              bytes: asset.storedBytes ?? asset.originalBytes,
              metadata: migratedMetadata,
            },
          });
          metadataValue = migratedMetadata;
          changed = true;
        }
      }

      // Provider-specific IDs/metadata can remain even when the primary asset
      // URL was already changed by an earlier partial migration. Scrub those
      // values here so published/editor records end Phase 3 provider-neutral.
      const metadataUrls = collectLegacyUrls(metadataValue);
      for (const url of metadataUrls) {
        if (replacements.has(url)) continue;
        const asset = await migrateSource({ adminId: website.adminId, sourceUrl: url, purpose, entityId: website.id, entityType: "WEBSITE", sourceField: `WebsiteAsset.${row.id}.metadata`, counters });
        if (asset?.publicUrl) replacements.set(url, asset.publicUrl);
      }
      const metadataWithUrls = replaceUrlsInJson(metadataValue, replacements);
      const scrubbedMetadata = scrubLegacyProviderMetadata(metadataWithUrls.value);
      if (metadataWithUrls.changed || scrubbedMetadata.changed) {
        await prisma.websiteAsset.update({ where: { id: row.id }, data: { metadata: scrubbedMetadata.value as Prisma.InputJsonValue } });
        changed = true;
      }
    }

    const migrateBrand = async (url: string | null, slot: "logo" | "favicon" | "social") => {
      if (!isLegacyMediaUrl(url)) return url;
      if (replacements.has(url)) return replacements.get(url)!;
      const asset = await migrateSource({ adminId: website.adminId, sourceUrl: url, purpose: "WEBSITE_BRAND", entityId: website.id, entityType: "WEBSITE", sourceField: `BusinessWebsite.${slot === "social" ? "socialImageUrl" : slot}`, counters });
      if (!asset?.publicUrl) return url;
      replacements.set(url, asset.publicUrl);
      await ensureWebsiteAssetRow({ websiteId: website.id, sourceUrl: url, asset, kind: "brand", slot });
      changed = true;
      return asset.publicUrl;
    };

    const logo = await migrateBrand(website.logo, "logo");
    const favicon = await migrateBrand(website.favicon, "favicon");
    const socialImageUrl = await migrateBrand(website.socialImageUrl, "social");

    const pages = await prisma.websitePage.findMany({ where: { websiteId: website.id }, orderBy: { id: "asc" } });
    const revisions = await prisma.websiteRevision.findMany({ where: { websiteId: website.id }, orderBy: { revisionNumber: "asc" } });

    const jsonValues: unknown[] = [website.websiteDesign, website.publishedDesignMetadata, website.publishedSnapshot];
    for (const page of pages) jsonValues.push(page.content, page.socialImageUrl);
    for (const revision of revisions) jsonValues.push(revision.snapshot);
    const remainingUrls = new Set<string>();
    for (const value of jsonValues) collectLegacyUrls(value, remainingUrls);

    for (const url of remainingUrls) {
      if (replacements.has(url)) continue;
      const asset = await migrateSource({ adminId: website.adminId, sourceUrl: url, purpose: "WEBSITE_CONTENT", entityId: website.id, entityType: "WEBSITE", sourceField: "Website JSON snapshot/content", counters });
      if (!asset?.publicUrl) continue;
      replacements.set(url, asset.publicUrl);
      await ensureWebsiteAssetRow({ websiteId: website.id, sourceUrl: url, asset, kind: "content" });
      changed = true;
    }

    const updateJson = (value: unknown) => {
      const replaced = replaceUrlsInJson(value, replacements);
      const scrubbed = scrubLegacyProviderMetadata(replaced.value);
      return { value: scrubbed.value, changed: replaced.changed || scrubbed.changed };
    };
    const websiteDesign = updateJson(website.websiteDesign);
    const publishedDesignMetadata = updateJson(website.publishedDesignMetadata);
    const publishedSnapshot = updateJson(website.publishedSnapshot);
    if (websiteDesign.changed || publishedDesignMetadata.changed || publishedSnapshot.changed || logo !== website.logo || favicon !== website.favicon || socialImageUrl !== website.socialImageUrl) {
      await prisma.businessWebsite.update({
        where: { id: website.id },
        data: {
          logo, favicon, socialImageUrl,
          ...(websiteDesign.changed ? { websiteDesign: websiteDesign.value as Prisma.InputJsonValue } : {}),
          ...(publishedDesignMetadata.changed ? { publishedDesignMetadata: publishedDesignMetadata.value as Prisma.InputJsonValue } : {}),
          ...(publishedSnapshot.changed ? { publishedSnapshot: publishedSnapshot.value as Prisma.InputJsonValue } : {}),
        },
      });
      changed = true;
    }

    for (const page of pages) {
      const content = updateJson(page.content);
      const pageSocial = isLegacyMediaUrl(page.socialImageUrl) ? replacements.get(page.socialImageUrl) ?? page.socialImageUrl : page.socialImageUrl;
      if (content.changed || pageSocial !== page.socialImageUrl) {
        await prisma.websitePage.update({ where: { id: page.id }, data: { ...(content.changed ? { content: content.value as Prisma.InputJsonValue } : {}), socialImageUrl: pageSocial } });
        changed = true;
      }
    }
    for (const revision of revisions) {
      const snapshot = updateJson(revision.snapshot);
      if (snapshot.changed) {
        await prisma.websiteRevision.update({ where: { id: revision.id }, data: { snapshot: snapshot.value as Prisma.InputJsonValue } });
        changed = true;
      }
    }

    if (changed) {
      await WebsiteProjectionCacheService.invalidateWebsite(website.id, website.adminId, { reason: "r2-media-migration" }).catch(() => undefined);
      counters.websitesInvalidated += 1;
    }
  },
);

const countLegacyReferences = async (adminId?: string) => {
  let total = 0;
  const users = await prisma.user.findMany({
    where: adminId ? { OR: [{ admin: { id: adminId } }, { staff: { adminId } }] } : {},
    select: { image: true },
  });
  total += users.filter((row) => isLegacyMediaUrl(row.image)).length;
  const admins = await prisma.adminProfile.findMany({ where: adminId ? { id: adminId } : {}, select: { businessLogo: true } });
  total += admins.filter((row) => isLegacyMediaUrl(row.businessLogo)).length;
  const attachments = await prisma.jobAttachment.findMany({ where: adminId ? { adminId } : {}, select: { fileUrl: true } });
  total += attachments.filter((row) => isLegacyMediaUrl(row.fileUrl)).length;
  const payments = await prisma.payment.findMany({ where: adminId ? { adminId } : {}, select: { paymentProofUrl: true, invoiceUrl: true } });
  total += payments.reduce((sum, row) => sum + Number(isLegacyMediaUrl(row.paymentProofUrl)) + Number(isLegacyMediaUrl(row.invoiceUrl)), 0);
  const billing = await prisma.billingHistory.findMany({ where: adminId ? { subscription: { adminId } } : {}, select: { paymentProofUrl: true, invoiceUrl: true } });
  total += billing.reduce((sum, row) => sum + Number(isLegacyMediaUrl(row.paymentProofUrl)) + Number(isLegacyMediaUrl(row.invoiceUrl)), 0);
  const expenses = await prisma.expense.findMany({ where: adminId ? { adminId } : {}, select: { receiptUrl: true, notes: true } });
  total += expenses.reduce((sum, row) => {
    const noteReceipt = row.notes?.match(NOTE_RECEIPT_PATTERN)?.[1];
    return sum + Number(isLegacyMediaUrl(row.receiptUrl)) + Number(Boolean(noteReceipt && isLegacyMediaUrl(noteReceipt)));
  }, 0);
  const websites = await prisma.businessWebsite.findMany({
    where: adminId ? { adminId } : {},
    select: { id: true, logo: true, favicon: true, socialImageUrl: true, websiteDesign: true, publishedDesignMetadata: true, publishedSnapshot: true },
  });
  for (const website of websites) {
    total += Number(isLegacyMediaUrl(website.logo)) + Number(isLegacyMediaUrl(website.favicon)) + Number(isLegacyMediaUrl(website.socialImageUrl));
    total += collectLegacyUrls(website.websiteDesign).size + collectLegacyUrls(website.publishedDesignMetadata).size + collectLegacyUrls(website.publishedSnapshot).size;
    const [pages, revisions, assets] = await Promise.all([
      prisma.websitePage.findMany({ where: { websiteId: website.id }, select: { content: true, socialImageUrl: true } }),
      prisma.websiteRevision.findMany({ where: { websiteId: website.id }, select: { snapshot: true } }),
      prisma.websiteAsset.findMany({ where: { websiteId: website.id }, select: { url: true, metadata: true } }),
    ]);
    for (const page of pages) total += collectLegacyUrls(page.content).size + Number(isLegacyMediaUrl(page.socialImageUrl));
    for (const revision of revisions) total += collectLegacyUrls(revision.snapshot).size;
    for (const asset of assets) total += Number(isLegacyMediaUrl(asset.url)) + collectLegacyUrls(asset.metadata).size;
  }
  return total;
};

const verifyMigratedObjects = async (adminId?: string) => {
  let failures = 0;
  let cursor: string | undefined;
  while (true) {
    const rows = await prisma.legacyMediaMigration.findMany({
      where: { status: "MIGRATED", targetMediaAssetId: { not: null }, ...(adminId ? { adminId } : {}) },
      orderBy: { id: "asc" }, take: BATCH_SIZE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, targetMediaAssetId: true },
    });
    if (!rows.length) break;
    for (const row of rows) {
      const asset = row.targetMediaAssetId ? await prisma.mediaAsset.findUnique({ where: { id: row.targetMediaAssetId } }) : null;
      if (!asset || asset.status !== "READY" || asset.deletedAt) { failures += 1; continue; }
      try {
        const head = await r2StorageService.headObject(asset.bucket, asset.objectKey);
        if (!head.ContentLength) failures += 1;
      } catch { failures += 1; }
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) break;
  }
  return failures;
};

export const runLegacyMediaMigration = async (options: LegacyMediaMigrationOptions = {}): Promise<LegacyMediaMigrationReport> => {
  const startedAt = new Date().toISOString();
  const counters = emptyCounters();
  const notes: string[] = [];
  const mode: LegacyMediaMigrationReport["mode"] = options.verifyOnly ? "verify" : options.dryRun ? "dry-run" : "migrate";

  if (options.dryRun || options.verifyOnly) {
    const remainingLegacyReferences = await countLegacyReferences(options.adminId);
    const r2VerificationFailures = options.verifyOnly ? await verifyMigratedObjects(options.adminId) : 0;
    return { mode, startedAt, finishedAt: new Date().toISOString(), counters, remainingLegacyReferences, r2VerificationFailures, notes };
  }

  await migrateAdminLogos(options, counters);
  await migrateUsers(options, counters);
  await migrateJobAttachments(options, counters);
  await migratePayments(options, counters);
  await migrateBillingHistory(options, counters);
  await migrateExpenses(options, counters);
  await migrateWebsites(options, counters);

  const remainingLegacyReferences = await countLegacyReferences(options.adminId);
  const r2VerificationFailures = await verifyMigratedObjects(options.adminId);
  if (remainingLegacyReferences) notes.push(`${remainingLegacyReferences} legacy media reference(s) remain. Review FAILED, MISSING and INVALID migration rows before removing the old provider data.`);
  if (r2VerificationFailures) notes.push(`${r2VerificationFailures} migrated R2 object(s) failed verification.`);
  return { mode, startedAt, finishedAt: new Date().toISOString(), counters, remainingLegacyReferences, r2VerificationFailures, notes };
};
