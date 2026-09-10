import { createHash, randomUUID } from "node:crypto";
import status from "http-status";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { r2StorageService } from "../../lib/storage/r2Storage.service";
import { R2_MAX_DOCUMENT_SIZE_MB, R2_MAX_IMAGE_SIZE_MB, R2_PRIVATE_BUCKET, R2_PUBLIC_BUCKET, R2_UPLOAD_URL_TTL_SECONDS } from "../../config/ENV";
import AppError from "../../errorHelper/AppError";
import { UserRole } from "../../generated/prisma/enums";
import type { IRequestUser } from "../../types/requestUser.interface";
import { optimizeImage } from "./imageOptimizer";
import { buildFinalObjectKey, buildTemporaryObjectKey } from "./mediaKeyBuilder";
import { isImageMimeType, MEDIA_PURPOSE_POLICY } from "./media.policy";
import type { InitiateMediaUploadInput, MediaPurpose, ServerMediaUploadInput } from "./media.types";


const STAFF_ALLOWED_PURPOSES = new Set<MediaPurpose>(["USER_AVATAR", "STAFF_AVATAR", "JOB_PHOTO", "JOB_ATTACHMENT"]);

const assertPurposeRole = (user: IRequestUser, purpose: MediaPurpose) => {
  if (user.role === UserRole.STAFF && !STAFF_ALLOWED_PURPOSES.has(purpose)) {
    throw new AppError(status.FORBIDDEN, "Staff are not allowed to upload this media type.", { code: "FORBIDDEN", retryable: false });
  }
};

const uploadLocks = new Set<string>();
const processingQueue: Array<() => void> = [];
let activeImageJobs = 0;
const maxImageJobs = Math.max(1, Math.min(8, Number(process.env.R2_IMAGE_PROCESSING_CONCURRENCY) || 2));

async function acquireImageSlot(): Promise<void> {
  if (activeImageJobs < maxImageJobs) {
    activeImageJobs += 1;
    return;
  }
  await new Promise<void>((resolve) => processingQueue.push(resolve));
  // A released slot is transferred directly to this waiter. Do not increment
  // activeImageJobs here or a newly arriving request could race the waiter and
  // temporarily exceed the configured Sharp concurrency limit.
}

function releaseImageSlot(): void {
  const next = processingQueue.shift();
  if (next) {
    next();
    return;
  }
  activeImageJobs = Math.max(0, activeImageJobs - 1);
}

async function withImageSlot<T>(work: () => Promise<T>): Promise<T> {
  await acquireImageSlot();
  try { return await work(); }
  finally { releaseImageSlot(); }
}

async function optimizeValidatedImage(buffer: Buffer, options: Parameters<typeof optimizeImage>[1]) {
  try {
    return await withImageSlot(() => optimizeImage(buffer, options));
  } catch {
    throw new AppError(status.BAD_REQUEST, "The uploaded image is invalid or cannot be processed safely.", {
      code: "MEDIA_IMAGE_INVALID",
      retryable: false,
      fieldErrors: { file: "Choose a valid JPEG, PNG, WebP, AVIF, HEIC, or HEIF image." },
    });
  }
}

async function downloadAndOptimizeR2Image(key: string, options: Parameters<typeof optimizeImage>[1]) {
  try {
    return await withImageSlot(async () => {
      // Keep both the R2 download buffer and Sharp's native allocations inside
      // the same concurrency slot so many simultaneous 10 MB uploads cannot
      // exhaust a small Cloud Run instance before processing even begins.
      const source = await r2StorageService.getObjectBuffer(R2_PRIVATE_BUCKET, key);
      return optimizeImage(source, options);
    });
  } catch {
    throw new AppError(status.BAD_REQUEST, "The uploaded image is invalid or cannot be processed safely.", {
      code: "MEDIA_IMAGE_INVALID",
      retryable: false,
      fieldErrors: { file: "Choose a valid JPEG, PNG, WebP, AVIF, HEIC, or HEIF image." },
    });
  }
}

const safeError = (message: string, field?: string) => new AppError(status.BAD_REQUEST, message, {
  code: "MEDIA_VALIDATION_ERROR",
  retryable: false,
  ...(field ? { fieldErrors: { [field]: message } } : {}),
});

const assertMimeAndSize = (purpose: MediaPurpose, contentType: string, size: number) => {
  const policy = MEDIA_PURPOSE_POLICY[purpose];
  const normalizedMime = contentType.toLowerCase();
  if (!policy.allowedMimeTypes.includes(normalizedMime)) throw safeError("This file type is not allowed for the selected upload purpose.", "contentType");
  const maxBytes = (isImageMimeType(normalizedMime) ? R2_MAX_IMAGE_SIZE_MB : R2_MAX_DOCUMENT_SIZE_MB) * 1024 * 1024;
  if (size <= 0 || size > maxBytes) throw safeError(`File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`, "size");
};

async function assertEntityOwnership(user: IRequestUser, adminId: string, purpose: MediaPurpose, entityId?: string) {
  const policy = MEDIA_PURPOSE_POLICY[purpose];

  // Website and subscription uploaders may not have the domain id at selection
  // time. Resolve it from authenticated tenant context rather than trusting the
  // browser to manufacture storage paths.
  if (!entityId && (purpose === "WEBSITE_BRAND" || purpose === "WEBSITE_CONTENT")) {
    const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
    entityId = website?.id;
  }
  if (!entityId && purpose === "SUBSCRIPTION_PROOF") {
    const subscription = await prisma.subscription.findFirst({ where: { adminId }, orderBy: { createdAt: "desc" }, select: { id: true } });
    entityId = subscription?.id;
  }
  if (policy.requireEntity && !entityId) throw safeError("entityId is required for this upload purpose.", "entityId");

  if (purpose === "USER_AVATAR") {
    if (entityId && entityId !== user.id) throw new AppError(status.FORBIDDEN, "You can only upload your own avatar.", { code: "FORBIDDEN", retryable: false });
    return user.id;
  }
  if (purpose === "BUSINESS_LOGO" || purpose === "BUSINESS_FAVICON") {
    if (user.role !== UserRole.ADMIN) throw new AppError(status.FORBIDDEN, "Only an administrator can update business branding.", { code: "FORBIDDEN", retryable: false });
    return undefined;
  }
  if (!entityId) return undefined;

  const owned = async (record: { adminId: string } | null) => {
    if (!record || record.adminId !== adminId) throw new AppError(status.NOT_FOUND, "Upload target was not found in this organization.", { code: "MEDIA_ENTITY_NOT_FOUND", retryable: false });
    return entityId;
  };

  switch (purpose) {
    case "STAFF_AVATAR": {
      const staff = await prisma.staffProfile.findUnique({ where: { id: entityId }, select: { adminId: true, userId: true } });
      await owned(staff);
      if (user.role === UserRole.STAFF && staff?.userId !== user.id) throw new AppError(status.FORBIDDEN, "Staff can only update their own avatar.", { code: "FORBIDDEN", retryable: false });
      return entityId;
    }
    case "SERVICE_IMAGE": return owned(await prisma.serviceCatalog.findUnique({ where: { id: entityId }, select: { adminId: true } }));
    case "WEBSITE_BRAND":
    case "WEBSITE_CONTENT": return owned(await prisma.businessWebsite.findUnique({ where: { id: entityId }, select: { adminId: true } }));
    case "JOB_PHOTO":
    case "JOB_ATTACHMENT": return owned(await prisma.job.findUnique({ where: { id: entityId }, select: { adminId: true } }));
    case "INVOICE_ATTACHMENT": return owned(await prisma.invoice.findUnique({ where: { id: entityId }, select: { adminId: true } }));
    case "PAYMENT_PROOF":
    case "PAYMENT_RECEIPT": return owned(await prisma.payment.findUnique({ where: { id: entityId }, select: { adminId: true } }));
    case "EXPENSE_RECEIPT": return owned(await prisma.expense.findUnique({ where: { id: entityId }, select: { adminId: true } }));
    case "SUBSCRIPTION_PROOF": return owned(await prisma.subscription.findUnique({ where: { id: entityId }, select: { adminId: true } }));
    default: return entityId;
  }
}

const assertPdfSignature = (prefix: Buffer) => {
  if (prefix.length < 5 || prefix.subarray(0, 5).toString("ascii") !== "%PDF-") throw safeError("The uploaded file is not a valid PDF.", "file");
};

const accessWhere = async (assetId: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, adminId, deletedAt: null } });
  if (!asset) throw new AppError(status.NOT_FOUND, "Media asset not found.", { code: "MEDIA_NOT_FOUND", retryable: false });
  if (user.role === UserRole.STAFF && asset.createdByUserId !== user.id) {
    throw new AppError(status.FORBIDDEN, "You do not have access to this media asset.", { code: "FORBIDDEN", retryable: false });
  }
  return asset;
};

async function createUploadSession(
  input: InitiateMediaUploadInput,
  adminId: string,
  entityId: string | undefined,
  createdByUserId: string | null,
) {
  assertMimeAndSize(input.purpose, input.contentType, input.size);

  const uploadId = randomUUID();
  const temporaryObjectKey = buildTemporaryObjectKey(adminId, uploadId, input.contentType);
  const expiresAt = new Date(Date.now() + R2_UPLOAD_URL_TTL_SECONDS * 1000);
  const asset = await prisma.mediaAsset.create({
    data: {
      id: uploadId,
      adminId,
      createdByUserId,
      bucket: MEDIA_PURPOSE_POLICY[input.purpose].visibility === "PUBLIC" ? R2_PUBLIC_BUCKET : R2_PRIVATE_BUCKET,
      objectKey: `pending/${uploadId}`,
      temporaryObjectKey,
      purpose: input.purpose,
      visibility: MEDIA_PURPOSE_POLICY[input.purpose].visibility,
      entityType: MEDIA_PURPOSE_POLICY[input.purpose].entityType,
      entityId: entityId ?? null,
      originalFilename: input.filename,
      originalMimeType: input.contentType,
      mimeType: input.contentType,
      originalBytes: input.size,
      status: "INITIATED",
      expiresAt,
    },
  });

  try {
    const uploadUrl = await r2StorageService.createUploadUrl({ key: temporaryObjectKey, contentType: input.contentType });
    return {
      uploadId: asset.id,
      uploadUrl,
      method: "PUT" as const,
      headers: { "Content-Type": input.contentType },
      expiresAt: expiresAt.toISOString(),
      maxBytes: input.size,
    };
  } catch (error) {
    await prisma.mediaAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
    throw error;
  }
}

async function initiateUpload(input: InitiateMediaUploadInput, user: IRequestUser) {
  assertPurposeRole(user, input.purpose);
  const adminId = await getAdminId(user);
  const entityId = await assertEntityOwnership(user, adminId, input.purpose, input.entityId);
  return createUploadSession(input, adminId, entityId, user.id);
}

/**
 * Internal tenant-scoped session creator for non-user principals such as the
 * client portal. Callers must perform their own domain authorization first.
 */
async function initiateUploadForTenant(
  input: InitiateMediaUploadInput,
  adminId: string,
  createdByUserId: string | null = null,
) {
  return createUploadSession(input, adminId, input.entityId, createdByUserId);
}

async function finalizeUpload(uploadId: string, user: IRequestUser) {
  if (uploadLocks.has(uploadId)) throw new AppError(status.CONFLICT, "This upload is already being finalized.", { code: "MEDIA_FINALIZE_IN_PROGRESS", retryable: true });
  uploadLocks.add(uploadId);
  let asset: Awaited<ReturnType<typeof accessWhere>> | null = null;
  let processingLeaseUpdatedAt: Date | null = null;
  try {
    asset = await accessWhere(uploadId, user);
    if (asset.status === "READY") return asset;
    if (!asset.temporaryObjectKey) throw new AppError(status.CONFLICT, "Upload has no temporary object.", { code: "MEDIA_INVALID_STATE", retryable: false });
    if (asset.expiresAt && asset.expiresAt.getTime() < Date.now() && asset.status !== "PROCESSING") {
      throw new AppError(status.GONE, "Upload session has expired. Start the upload again.", { code: "MEDIA_UPLOAD_EXPIRED", retryable: true });
    }

    // Database claim is the real concurrency boundary across Cloud Run/API
    // instances. A stale PROCESSING lease can be reclaimed after five minutes.
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    const claim = await prisma.mediaAsset.updateMany({
      where: {
        id: asset.id,
        adminId: asset.adminId,
        OR: [
          { status: { in: ["INITIATED", "FAILED"] } },
          { status: "PROCESSING", updatedAt: { lt: staleBefore } },
        ],
      },
      data: { status: "PROCESSING" },
    });
    if (claim.count !== 1) {
      const latest = await prisma.mediaAsset.findUnique({ where: { id: asset.id } });
      if (latest?.status === "READY") return latest;
      throw new AppError(status.CONFLICT, "This upload is already being finalized.", { code: "MEDIA_FINALIZE_IN_PROGRESS", retryable: true });
    }
    const claimedAsset = await prisma.mediaAsset.findUnique({ where: { id: asset.id }, select: { updatedAt: true } });
    processingLeaseUpdatedAt = claimedAsset?.updatedAt ?? null;
    let head;
    try {
      head = await r2StorageService.headObject(R2_PRIVATE_BUCKET, asset.temporaryObjectKey);
    } catch (cause) {
      void cause;
      throw new AppError(status.CONFLICT, "The uploaded object was not found in R2. Upload the file before finalizing.", {
        code: "MEDIA_UPLOAD_MISSING", retryable: true,
      });
    }
    const uploadedBytes = Number(head.ContentLength ?? 0);
    const uploadedType = String(head.ContentType ?? "").toLowerCase();
    assertMimeAndSize(asset.purpose as MediaPurpose, uploadedType, uploadedBytes);
    if (uploadedBytes !== asset.originalBytes) throw safeError("Uploaded file size did not match the initiated upload.", "file");
    if (uploadedType !== asset.originalMimeType.toLowerCase()) throw safeError("Uploaded Content-Type did not match the initiated upload.", "file");

    const policy = MEDIA_PURPOSE_POLICY[asset.purpose as MediaPurpose];
    let finalMime = uploadedType;
    let storedBytes = uploadedBytes;
    let width: number | null = null;
    let height: number | null = null;
    let checksum: string | null = null;
    let etag: string | null = null;
    let finalObjectKey: string;

    if (isImageMimeType(uploadedType)) {
      const optimized = await downloadAndOptimizeR2Image(asset.temporaryObjectKey, {
        contentType: uploadedType,
        maxDimension: policy.maxDimension ?? 1600,
        targetBytes: policy.targetBytes ?? 400 * 1024,
        favicon: asset.purpose === "BUSINESS_FAVICON",
      });
      finalMime = optimized.mimeType;
      storedBytes = optimized.buffer.length;
      width = optimized.width;
      height = optimized.height;
      checksum = createHash("sha256").update(optimized.buffer).digest("hex");
      finalObjectKey = buildFinalObjectKey({ adminId: asset.adminId, purpose: asset.purpose as MediaPurpose, entityId: asset.entityId, mimeType: finalMime, objectId: asset.id });
      const put = await r2StorageService.putObject({ bucket: asset.bucket, key: finalObjectKey, body: optimized.buffer, contentType: finalMime, isPublic: asset.visibility === "PUBLIC" });
      etag = put.ETag?.replace(/"/g, "") ?? null;
    } else {
      if (uploadedType !== "application/pdf") throw safeError("Unsupported document type.", "file");
      assertPdfSignature(await r2StorageService.getObjectPrefix(R2_PRIVATE_BUCKET, asset.temporaryObjectKey, 8));
      finalObjectKey = buildFinalObjectKey({ adminId: asset.adminId, purpose: asset.purpose as MediaPurpose, entityId: asset.entityId, mimeType: uploadedType, objectId: asset.id });
      const copy = await r2StorageService.copyObject({ sourceBucket: R2_PRIVATE_BUCKET, sourceKey: asset.temporaryObjectKey, destinationBucket: asset.bucket, destinationKey: finalObjectKey, contentType: uploadedType, isPublic: false });
      etag = copy.CopyObjectResult?.ETag?.replace(/"/g, "") ?? null;
    }

    const publicUrl = asset.visibility === "PUBLIC" ? r2StorageService.publicUrl(finalObjectKey) : null;
    // Persist READY before deleting the temporary source. If the database write
    // fails after the R2 put/copy, the temp object remains available and a
    // retry can safely write the same immutable final key again.
    const readyAsset = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        objectKey: finalObjectKey,
        temporaryObjectKey: null,
        mimeType: finalMime,
        storedBytes,
        width,
        height,
        checksum,
        etag,
        publicUrl,
        status: "READY",
        finalizedAt: new Date(),
        expiresAt: null,
      },
    });
    await r2StorageService.deleteObject(R2_PRIVATE_BUCKET, asset.temporaryObjectKey).catch(() => undefined);
    return readyAsset;
  } catch (error) {
    // Only the worker that acquired this exact PROCESSING lease may mark it
    // failed. A concurrent finalize request that merely observes the lease must
    // never flip another worker back to FAILED and open a duplicate processor.
    if (asset && processingLeaseUpdatedAt) {
      await prisma.mediaAsset.updateMany({
        where: { id: asset.id, status: "PROCESSING", updatedAt: processingLeaseUpdatedAt },
        data: { status: "FAILED" },
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    uploadLocks.delete(uploadId);
  }
}

async function finalizeUploadForTenant(uploadId: string, adminId: string) {
  // finalizeUpload only needs an ADMIN tenant identity to scope accessWhere;
  // no user-owned operation is performed here. This wrapper is reserved for
  // domain services that have already authorized a non-session principal
  // (currently the client portal) against the same tenant.
  const tenantActor: IRequestUser = {
    id: `tenant-media:${adminId}`,
    email: "tenant-media@internal.invalid",
    role: UserRole.ADMIN,
    adminId,
  };
  return finalizeUpload(uploadId, tenantActor);
}

async function uploadFromServerForTenant(input: ServerMediaUploadInput, adminId: string, createdByUserId?: string | null) {
  assertMimeAndSize(input.purpose, input.contentType, input.buffer.length);
  const policy = MEDIA_PURPOSE_POLICY[input.purpose];
  let finalBuffer = input.buffer;
  let finalMime = input.contentType.toLowerCase();
  let width: number | null = null;
  let height: number | null = null;

  if (isImageMimeType(finalMime)) {
    const optimized = await optimizeValidatedImage(finalBuffer, {
      contentType: finalMime, maxDimension: policy.maxDimension ?? 1600, targetBytes: policy.targetBytes ?? 400 * 1024, favicon: input.purpose === "BUSINESS_FAVICON",
    });
    finalBuffer = optimized.buffer; finalMime = optimized.mimeType; width = optimized.width; height = optimized.height;
  } else if (finalMime === "application/pdf") {
    assertPdfSignature(finalBuffer.subarray(0, 8));
  }

  const bucket = policy.visibility === "PUBLIC" ? R2_PUBLIC_BUCKET : R2_PRIVATE_BUCKET;
  const objectKey = buildFinalObjectKey({ adminId, purpose: input.purpose, entityId: input.entityId, mimeType: finalMime });
  const put = await r2StorageService.putObject({ bucket, key: objectKey, body: finalBuffer, contentType: finalMime, isPublic: policy.visibility === "PUBLIC" });
  const publicUrl = policy.visibility === "PUBLIC" ? r2StorageService.publicUrl(objectKey) : null;
  return prisma.mediaAsset.create({
    data: {
      adminId, createdByUserId: createdByUserId ?? null, bucket, objectKey, purpose: input.purpose, visibility: policy.visibility,
      entityType: policy.entityType, entityId: input.entityId ?? null, originalFilename: input.filename, originalMimeType: input.contentType.toLowerCase(),
      mimeType: finalMime, originalBytes: input.buffer.length, storedBytes: finalBuffer.length, width, height,
      checksum: createHash("sha256").update(finalBuffer).digest("hex"), etag: put.ETag?.replace(/"/g, "") ?? null, publicUrl, status: "READY", finalizedAt: new Date(),
    },
  });
}

async function uploadFromServer(input: ServerMediaUploadInput, user: IRequestUser) {
  assertPurposeRole(user, input.purpose);
  const adminId = await getAdminId(user);
  const entityId = await assertEntityOwnership(user, adminId, input.purpose, input.entityId);
  return uploadFromServerForTenant({ ...input, entityId }, adminId, user.id);
}

async function getAsset(assetId: string, user: IRequestUser) {
  return accessWhere(assetId, user);
}

async function getDownloadUrl(assetId: string, user: IRequestUser) {
  const asset = await accessWhere(assetId, user);
  if (asset.status !== "READY") throw new AppError(status.CONFLICT, "Media asset is not ready.", { code: "MEDIA_NOT_READY", retryable: true });
  if (asset.visibility === "PUBLIC" && asset.publicUrl) return { url: asset.publicUrl, expiresAt: null };
  const url = await r2StorageService.createPrivateDownloadUrl(asset.bucket, asset.objectKey, asset.originalFilename);
  return { url, expiresAt: new Date(Date.now() + Number(process.env.R2_PRIVATE_DOWNLOAD_TTL_SECONDS || 300) * 1000).toISOString() };
}

async function assertAssetNotInUse(assetId: string): Promise<void> {
  const references = await Promise.all([
    prisma.user.findFirst({ where: { imageMediaAssetId: assetId }, select: { id: true } }),
    prisma.adminProfile.findFirst({ where: { businessLogoMediaAssetId: assetId }, select: { id: true } }),
    prisma.jobAttachment.findFirst({ where: { mediaAssetId: assetId }, select: { id: true } }),
    prisma.payment.findFirst({ where: { OR: [{ paymentProofMediaAssetId: assetId }, { receiptMediaAssetId: assetId }] }, select: { id: true } }),
    prisma.billingHistory.findFirst({ where: { paymentProofMediaAssetId: assetId }, select: { id: true } }),
    prisma.expense.findFirst({ where: { receiptMediaAssetId: assetId }, select: { id: true } }),
    prisma.websiteAsset.findFirst({ where: { mediaAssetId: assetId }, select: { id: true } }),
  ]);
  if (references.some(Boolean)) {
    throw new AppError(status.CONFLICT, "This media asset is currently attached to a record. Remove or replace it from that record first.", {
      code: "MEDIA_ASSET_IN_USE",
      retryable: false,
    });
  }
}

async function deleteClaimedTenantAsset(asset: {
  id: string; adminId: string; status: string; updatedAt: Date; bucket: string; objectKey: string; temporaryObjectKey: string | null; deletedAt: Date | null;
}) {
  if (asset.deletedAt || asset.status === "DELETED") return;
  if (asset.status === "PROCESSING") {
    throw new AppError(status.CONFLICT, "This media asset is still being finalized. Try again after processing completes.", {
      code: "MEDIA_FINALIZE_IN_PROGRESS", retryable: true,
    });
  }

  let current = asset;
  if (current.status !== "DELETING") {
    if (current.status === "READY") await assertAssetNotInUse(current.id);
    const claimed = await prisma.mediaAsset.updateMany({
      where: {
        id: current.id,
        adminId: current.adminId,
        deletedAt: null,
        status: current.status,
        updatedAt: current.updatedAt,
      },
      data: { status: "DELETING" },
    });
    if (claimed.count !== 1) {
      const latest = await prisma.mediaAsset.findFirst({ where: { id: current.id, adminId: current.adminId } });
      if (!latest || latest.deletedAt || latest.status === "DELETED") return;
      return deleteClaimedTenantAsset(latest);
    }
    const claimedRow = await prisma.mediaAsset.findUnique({ where: { id: current.id } });
    if (!claimedRow) return;
    current = claimedRow;
  }

  // Marking DELETING before touching R2 is the concurrency barrier: finalize
  // only claims INITIATED/FAILED rows, so a cancel/delete can never race a
  // processor and resurrect an object after it has been removed. R2 deletes
  // are idempotent, so a transient failure can safely retry this state.
  await Promise.all([
    current.objectKey.startsWith("pending/") ? Promise.resolve() : r2StorageService.deleteObject(current.bucket, current.objectKey),
    current.temporaryObjectKey ? r2StorageService.deleteObject(R2_PRIVATE_BUCKET, current.temporaryObjectKey) : Promise.resolve(),
  ]);

  await prisma.mediaAsset.updateMany({
    where: { id: current.id, adminId: current.adminId, status: "DELETING", deletedAt: null },
    data: { status: "DELETED", deletedAt: new Date(), temporaryObjectKey: null },
  });
}

async function deleteAsset(assetId: string, user: IRequestUser) {
  const asset = await accessWhere(assetId, user);
  await deleteClaimedTenantAsset(asset);
  return prisma.mediaAsset.findUnique({ where: { id: asset.id } });
}

async function requireReadyAssetForPurpose(assetId: string, user: IRequestUser, purpose: MediaPurpose, entityId?: string) {
  const asset = await accessWhere(assetId, user);
  if (asset.status !== "READY" || asset.deletedAt) {
    throw new AppError(status.CONFLICT, "Media asset is not ready.", { code: "MEDIA_NOT_READY", retryable: true });
  }
  if (asset.purpose !== purpose) {
    throw new AppError(status.BAD_REQUEST, "The uploaded media has the wrong purpose for this field.", { code: "MEDIA_PURPOSE_MISMATCH", retryable: false });
  }
  if (entityId && asset.entityId && asset.entityId !== entityId) {
    throw new AppError(status.BAD_REQUEST, "The uploaded media belongs to a different record.", { code: "MEDIA_ENTITY_MISMATCH", retryable: false });
  }
  return asset;
}

async function bindReadyAsset(assetId: string, user: IRequestUser, purpose: MediaPurpose, entityId?: string) {
  const adminId = await getAdminId(user);
  if (entityId) await assertEntityOwnership(user, adminId, purpose, entityId);
  const asset = await requireReadyAssetForPurpose(assetId, user, purpose, entityId);
  if (entityId && asset.entityId !== entityId) {
    return prisma.mediaAsset.update({ where: { id: asset.id }, data: { entityId } });
  }
  return asset;
}

async function getAssetForTenant(assetId: string, adminId: string) {
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, adminId, status: "READY", deletedAt: null } });
  if (!asset) throw new AppError(status.NOT_FOUND, "Media asset not found.", { code: "MEDIA_NOT_FOUND", retryable: false });
  return asset;
}

async function bindReadyAssetForTenant(assetId: string, adminId: string, purpose: MediaPurpose, entityId?: string) {
  const asset = await getAssetForTenant(assetId, adminId);
  if (asset.purpose !== purpose) {
    throw new AppError(status.BAD_REQUEST, "The uploaded media has the wrong purpose for this field.", { code: "MEDIA_PURPOSE_MISMATCH", retryable: false });
  }
  if (entityId && asset.entityId && asset.entityId !== entityId) {
    throw new AppError(status.BAD_REQUEST, "The uploaded media belongs to a different record.", { code: "MEDIA_ENTITY_MISMATCH", retryable: false });
  }
  if (entityId && asset.entityId !== entityId) {
    return prisma.mediaAsset.update({ where: { id: asset.id }, data: { entityId } });
  }
  return asset;
}

async function getReadUrlForTenant(assetId: string, adminId: string, downloadName?: string) {
  const asset = await getAssetForTenant(assetId, adminId);
  if (asset.visibility === "PUBLIC" && asset.publicUrl) return asset.publicUrl;
  return r2StorageService.createPrivateReadUrl(asset.bucket, asset.objectKey, downloadName);
}

async function deleteAssetForTenant(assetId: string, adminId: string) {
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, adminId } });
  if (!asset || asset.deletedAt || asset.status === "DELETED") return;
  await deleteClaimedTenantAsset(asset);
}

async function deleteAssetIfUnreferencedForTenant(assetId: string, adminId: string) {
  try {
    await deleteAssetForTenant(assetId, adminId);
  } catch (error) {
    if (error instanceof AppError && (error.code === "MEDIA_ASSET_IN_USE" || error.code === "MEDIA_FINALIZE_IN_PROGRESS")) return;
    throw error;
  }
}

async function storageHealth() { return r2StorageService.probe(); }

export const mediaService = {
  initiateUpload, initiateUploadForTenant, finalizeUpload, finalizeUploadForTenant,
  uploadFromServer, uploadFromServerForTenant, getAsset, getDownloadUrl, deleteAsset,
  requireReadyAssetForPurpose, bindReadyAsset, bindReadyAssetForTenant, getAssetForTenant, getReadUrlForTenant,
  deleteAssetForTenant, deleteAssetIfUnreferencedForTenant, storageHealth,
};
