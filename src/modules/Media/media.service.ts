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

async function withImageSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeImageJobs >= maxImageJobs) await new Promise<void>((resolve) => processingQueue.push(resolve));
  activeImageJobs += 1;
  try { return await work(); }
  finally {
    activeImageJobs -= 1;
    processingQueue.shift()?.();
  }
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
  if (policy.requireEntity && !entityId) throw safeError("entityId is required for this upload purpose.", "entityId");

  if (purpose === "USER_AVATAR") {
    if (entityId && entityId !== user.id) throw new AppError(status.FORBIDDEN, "You can only upload your own avatar.", { code: "FORBIDDEN", retryable: false });
    return user.id;
  }
  if (purpose === "BUSINESS_LOGO" || purpose === "BUSINESS_FAVICON") {
    if (user.role !== UserRole.ADMIN) throw new AppError(status.FORBIDDEN, "Only an administrator can update business branding.", { code: "FORBIDDEN", retryable: false });
    return adminId;
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
    case "PAYMENT_PROOF": return owned(await prisma.payment.findUnique({ where: { id: entityId }, select: { adminId: true } }));
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

async function initiateUpload(input: InitiateMediaUploadInput, user: IRequestUser) {
  assertPurposeRole(user, input.purpose);
  const adminId = await getAdminId(user);
  const entityId = await assertEntityOwnership(user, adminId, input.purpose, input.entityId);
  assertMimeAndSize(input.purpose, input.contentType, input.size);

  const uploadId = randomUUID();
  const temporaryObjectKey = buildTemporaryObjectKey(adminId, uploadId, input.contentType);
  const expiresAt = new Date(Date.now() + R2_UPLOAD_URL_TTL_SECONDS * 1000);
  const asset = await prisma.mediaAsset.create({
    data: {
      id: uploadId,
      adminId,
      createdByUserId: user.id,
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

async function finalizeUpload(uploadId: string, user: IRequestUser) {
  if (uploadLocks.has(uploadId)) throw new AppError(status.CONFLICT, "This upload is already being finalized.", { code: "MEDIA_FINALIZE_IN_PROGRESS", retryable: true });
  uploadLocks.add(uploadId);
  let asset: Awaited<ReturnType<typeof accessWhere>> | null = null;
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
      const source = await r2StorageService.getObjectBuffer(R2_PRIVATE_BUCKET, asset.temporaryObjectKey);
      const optimized = await optimizeValidatedImage(source, {
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

    await r2StorageService.deleteObject(R2_PRIVATE_BUCKET, asset.temporaryObjectKey).catch(() => undefined);
    const publicUrl = asset.visibility === "PUBLIC" ? r2StorageService.publicUrl(finalObjectKey) : null;
    return await prisma.mediaAsset.update({
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
  } catch (error) {
    if (asset) await prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "FAILED" } }).catch(() => undefined);
    throw error;
  } finally {
    uploadLocks.delete(uploadId);
  }
}

async function uploadFromServer(input: ServerMediaUploadInput, user: IRequestUser) {
  assertPurposeRole(user, input.purpose);
  const adminId = await getAdminId(user);
  const entityId = await assertEntityOwnership(user, adminId, input.purpose, input.entityId);
  assertMimeAndSize(input.purpose, input.contentType, input.buffer.length);
  const policy = MEDIA_PURPOSE_POLICY[input.purpose];
  let finalBuffer = input.buffer;
  let finalMime = input.contentType.toLowerCase();
  let width: number | null = null;
  let height: number | null = null;

  if (isImageMimeType(finalMime)) {
    const optimized = await optimizeValidatedImage(finalBuffer, {
      contentType: finalMime,
      maxDimension: policy.maxDimension ?? 1600,
      targetBytes: policy.targetBytes ?? 400 * 1024,
      favicon: input.purpose === "BUSINESS_FAVICON",
    });
    finalBuffer = optimized.buffer;
    finalMime = optimized.mimeType;
    width = optimized.width;
    height = optimized.height;
  } else if (finalMime === "application/pdf") {
    assertPdfSignature(finalBuffer.subarray(0, 8));
  }

  const bucket = policy.visibility === "PUBLIC" ? R2_PUBLIC_BUCKET : R2_PRIVATE_BUCKET;
  const objectKey = buildFinalObjectKey({ adminId, purpose: input.purpose, entityId, mimeType: finalMime });
  const put = await r2StorageService.putObject({ bucket, key: objectKey, body: finalBuffer, contentType: finalMime, isPublic: policy.visibility === "PUBLIC" });
  const publicUrl = policy.visibility === "PUBLIC" ? r2StorageService.publicUrl(objectKey) : null;
  return prisma.mediaAsset.create({
    data: {
      adminId,
      createdByUserId: user.id,
      bucket,
      objectKey,
      purpose: input.purpose,
      visibility: policy.visibility,
      entityType: policy.entityType,
      entityId: entityId ?? null,
      originalFilename: input.filename,
      originalMimeType: input.contentType.toLowerCase(),
      mimeType: finalMime,
      originalBytes: input.buffer.length,
      storedBytes: finalBuffer.length,
      width,
      height,
      checksum: createHash("sha256").update(finalBuffer).digest("hex"),
      etag: put.ETag?.replace(/"/g, "") ?? null,
      publicUrl,
      status: "READY",
      finalizedAt: new Date(),
    },
  });
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

async function deleteAsset(assetId: string, user: IRequestUser) {
  const asset = await accessWhere(assetId, user);
  await Promise.all([
    asset.objectKey.startsWith("pending/") ? Promise.resolve() : r2StorageService.deleteObject(asset.bucket, asset.objectKey),
    asset.temporaryObjectKey ? r2StorageService.deleteObject(R2_PRIVATE_BUCKET, asset.temporaryObjectKey) : Promise.resolve(),
  ]);
  return prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: "DELETED", deletedAt: new Date(), temporaryObjectKey: null } });
}

async function storageHealth() { return r2StorageService.probe(); }

export const mediaService = { initiateUpload, finalizeUpload, uploadFromServer, getAsset, getDownloadUrl, deleteAsset, storageHealth };
