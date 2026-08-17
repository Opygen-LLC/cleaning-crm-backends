import { randomUUID } from "crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  CLOUDINARY_CLOUD_NAME,
} from "../../config/ENV";
import { cloudinaryUpload } from "../../config/cloudinary";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { prisma } from "../../lib/prisma/prisma";
import type { IRequestUser } from "../../types/requestUser.interface";
import type {
  WebsiteBrandAssetKind,
  WebsiteBrandUploadFinalizeInput,
  WebsiteBrandUploadSignatureInput,
} from "./website.interface";
import { WebsiteService } from "./website.service";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);
const ALLOWED_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "avif"]);
const LIMITS: Record<WebsiteBrandAssetKind, { maxBytes: number; maxWidth: number; maxHeight: number; minWidth: number; minHeight: number }> = {
  logo: { maxBytes: 5 * 1024 * 1024, maxWidth: 1600, maxHeight: 1600, minWidth: 64, minHeight: 24 },
  favicon: { maxBytes: 2 * 1024 * 1024, maxWidth: 512, maxHeight: 512, minWidth: 32, minHeight: 32 },
  // 1200×630 is the canonical OpenGraph target, but accept a sensible source
  // range and generate immutable share-safe derivatives during finalization.
  social: { maxBytes: 5 * 1024 * 1024, maxWidth: 4000, maxHeight: 3000, minWidth: 600, minHeight: 315 },
};
const SIGNATURE_TTL_SECONDS = 10 * 60;

const assertCloudinaryConfigured = () => {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Website image storage is not configured");
  }
};

const folderFor = (websiteId: string) => `Cleaning-CRM/websites/${websiteId}/brand`;
const publicIdPrefix = (kind: WebsiteBrandAssetKind) => `${kind}-`;

const eagerFor = (kind: WebsiteBrandAssetKind) => {
  if (kind === "social") {
    return [600, 1200].flatMap((width) => {
      const height = Math.round(width * 630 / 1200);
      return [
        `c_fill,g_auto,w_${width},h_${height},q_auto:good,f_jpg`,
        `c_fill,g_auto,w_${width},h_${height},q_auto:good,f_webp`,
        `c_fill,g_auto,w_${width},h_${height},q_auto:good,f_avif`,
      ];
    }).join("|");
  }
  const widths = kind === "favicon" ? [64, 128, 256] : [128, 256, 512, 1024];
  return widths.flatMap((width) => [
    `c_limit,w_${width},q_auto:good,f_webp`,
    `c_limit,w_${width},q_auto:good,f_avif`,
  ]).join("|");
};

const assertDeclaredUpload = (input: WebsiteBrandUploadSignatureInput) => {
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new AppError(status.BAD_REQUEST, "Upload a JPEG, PNG, WEBP, or AVIF image");
  }
  const limit = LIMITS[input.kind];
  if (!Number.isFinite(input.bytes) || input.bytes <= 0 || input.bytes > limit.maxBytes) {
    const label = input.kind === "logo" ? "Logo" : input.kind === "favicon" ? "Favicon" : "Social share image";
    throw new AppError(status.BAD_REQUEST, `${label} must be smaller than ${Math.round(limit.maxBytes / 1024 / 1024)} MB`);
  }
};

const getResourceContext = (resource: any) => resource?.context?.custom ?? resource?.context ?? {};

const cleanupRejectedUpload = async (publicId: string) => {
  try {
    await cloudinaryUpload.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch {
    // Best-effort cleanup only. The validation error remains authoritative.
  }
};

const assertResourceDimensions = (kind: WebsiteBrandAssetKind, resource: any) => {
  const width = Number(resource?.width ?? 0);
  const height = Number(resource?.height ?? 0);
  const bytes = Number(resource?.bytes ?? 0);
  const format = String(resource?.format ?? "").toLowerCase();
  const limit = LIMITS[kind];

  if (!ALLOWED_FORMATS.has(format)) throw new AppError(status.BAD_REQUEST, "Unsupported image format");
  const label = kind === "logo" ? "Logo" : kind === "favicon" ? "Favicon" : "Social share image";
  if (!width || !height || width < limit.minWidth || height < limit.minHeight) {
    throw new AppError(status.BAD_REQUEST, `${label} dimensions are too small`);
  }
  if (width > limit.maxWidth || height > limit.maxHeight) {
    throw new AppError(status.BAD_REQUEST, `${label} dimensions are too large`);
  }
  if (!bytes || bytes > limit.maxBytes) {
    throw new AppError(status.BAD_REQUEST, `${label} file is too large`);
  }
  const ratio = width / height;
  if (kind === "favicon" && (ratio < 0.8 || ratio > 1.25)) {
    throw new AppError(status.BAD_REQUEST, "Favicon must be approximately square");
  }
  if (kind === "logo" && (ratio < 0.1 || ratio > 10)) {
    throw new AppError(status.BAD_REQUEST, "Logo aspect ratio is not supported");
  }
  if (kind === "social" && (ratio < 1.35 || ratio > 2.2)) {
    throw new AppError(status.BAD_REQUEST, "Social share image should use a landscape aspect ratio close to 1200×630");
  }
  return { width, height, bytes, format };
};

const variantUrl = (
  publicId: string,
  width: number,
  format: "webp" | "avif" | "png" | "jpg",
  options: { height?: number; crop?: "limit" | "fill"; gravity?: "auto" } = {},
) =>
  cloudinaryUpload.url(publicId, {
    secure: true,
    format,
    transformation: [{
      width,
      ...(options.height ? { height: options.height } : {}),
      crop: options.crop ?? "limit",
      ...(options.gravity ? { gravity: options.gravity } : {}),
      quality: format === "png" ? undefined : "auto:good",
    }],
  });

const requestBrandUploadSignature = async (input: WebsiteBrandUploadSignatureInput, user: IRequestUser) => {
  assertCloudinaryConfigured();
  assertDeclaredUpload(input);
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true, status: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  if (website.status === "SUSPENDED") {
    throw new AppError(status.CONFLICT, "A suspended website cannot upload branding assets");
  }

  const folder = folderFor(website.id);
  const token = randomUUID();
  const publicId = `${folder}/${publicIdPrefix(input.kind)}${token}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const expiresAtEpoch = timestamp + SIGNATURE_TTL_SECONDS;
  const context = `website_id=${website.id}|asset_kind=${input.kind}|upload_token=${token}|expires_at=${expiresAtEpoch}`;
  const signedParams: Record<string, string | number | boolean> = {
    timestamp,
    public_id: publicId,
    overwrite: false,
    unique_filename: false,
    allowed_formats: "jpg,jpeg,png,webp,avif",
    eager: eagerFor(input.kind),
    context,
  };
  const signature = cloudinaryUpload.utils.api_sign_request(signedParams, CLOUDINARY_API_SECRET);

  return {
    kind: input.kind,
    publicId,
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/image/upload`,
    expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
    maxBytes: LIMITS[input.kind].maxBytes,
    fields: {
      api_key: CLOUDINARY_API_KEY,
      timestamp: String(timestamp),
      public_id: publicId,
      overwrite: "false",
      unique_filename: "false",
      allowed_formats: "jpg,jpeg,png,webp,avif",
      eager: eagerFor(input.kind),
      context,
      signature,
    },
  };
};

const finalizeBrandUpload = async (input: WebsiteBrandUploadFinalizeInput, user: IRequestUser) => {
  assertCloudinaryConfigured();
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true, status: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  if (website.status === "SUSPENDED") throw new AppError(status.CONFLICT, "A suspended website cannot upload branding assets");
  const expectedFolder = folderFor(website.id);
  const normalizedPublicId = input.publicId.trim();
  if (!normalizedPublicId.startsWith(`${expectedFolder}/${publicIdPrefix(input.kind)}`)) {
    throw new AppError(status.FORBIDDEN, "This upload does not belong to your website");
  }

  let resource: any;
  try {
    resource = await cloudinaryUpload.api.resource(normalizedPublicId, {
      resource_type: "image",
      context: true,
    });
  } catch {
    throw new AppError(status.BAD_REQUEST, "Uploaded image could not be verified");
  }

  try {
    const context = getResourceContext(resource);
    if (String(context.website_id ?? "") !== website.id || String(context.asset_kind ?? "") !== input.kind) {
      throw new AppError(status.FORBIDDEN, "This upload does not belong to your website");
    }
    const expiresAt = Number(context.expires_at ?? 0);
    if (!expiresAt || Math.floor(Date.now() / 1000) > expiresAt) {
      throw new AppError(status.BAD_REQUEST, "This upload authorization expired. Please upload the image again.");
    }
    const { width, height, bytes, format } = assertResourceDimensions(input.kind, resource);
    const variants = input.kind === "favicon"
      ? {
          png: { 64: variantUrl(normalizedPublicId, 64, "png"), 128: variantUrl(normalizedPublicId, 128, "png"), 256: variantUrl(normalizedPublicId, 256, "png") },
          webp: { 64: variantUrl(normalizedPublicId, 64, "webp"), 128: variantUrl(normalizedPublicId, 128, "webp"), 256: variantUrl(normalizedPublicId, 256, "webp") },
          avif: { 64: variantUrl(normalizedPublicId, 64, "avif"), 128: variantUrl(normalizedPublicId, 128, "avif"), 256: variantUrl(normalizedPublicId, 256, "avif") },
        }
      : input.kind === "social"
        ? {
            jpg: {
              600: variantUrl(normalizedPublicId, 600, "jpg", { height: 315, crop: "fill", gravity: "auto" }),
              1200: variantUrl(normalizedPublicId, 1200, "jpg", { height: 630, crop: "fill", gravity: "auto" }),
            },
            webp: {
              600: variantUrl(normalizedPublicId, 600, "webp", { height: 315, crop: "fill", gravity: "auto" }),
              1200: variantUrl(normalizedPublicId, 1200, "webp", { height: 630, crop: "fill", gravity: "auto" }),
            },
            avif: {
              600: variantUrl(normalizedPublicId, 600, "avif", { height: 315, crop: "fill", gravity: "auto" }),
              1200: variantUrl(normalizedPublicId, 1200, "avif", { height: 630, crop: "fill", gravity: "auto" }),
            },
          }
        : {
            webp: { 128: variantUrl(normalizedPublicId, 128, "webp"), 256: variantUrl(normalizedPublicId, 256, "webp"), 512: variantUrl(normalizedPublicId, 512, "webp"), 1024: variantUrl(normalizedPublicId, 1024, "webp") },
            avif: { 128: variantUrl(normalizedPublicId, 128, "avif"), 256: variantUrl(normalizedPublicId, 256, "avif"), 512: variantUrl(normalizedPublicId, 512, "avif"), 1024: variantUrl(normalizedPublicId, 1024, "avif") },
          };
    const primaryUrl = input.kind === "favicon"
      ? variantUrl(normalizedPublicId, 256, "png")
      : input.kind === "social"
        ? variantUrl(normalizedPublicId, 1200, "jpg", { height: 630, crop: "fill", gravity: "auto" })
        : variantUrl(normalizedPublicId, 512, "webp");

    return WebsiteService.attachManagedBrandAsset({
      kind: input.kind,
      publicId: normalizedPublicId,
      url: primaryUrl,
      mimeType: input.kind === "social" ? "image/jpeg" : `image/${format === "jpg" ? "jpeg" : format}`,
      width,
      height,
      bytes,
      folder: expectedFolder,
      metadata: {
        provider: "cloudinary",
        kind: "brand",
        slot: input.kind,
        immutable: true,
        originalUrl: resource.secure_url,
        variants,
      },
    }, user);
  } catch (error) {
    await cleanupRejectedUpload(normalizedPublicId);
    throw error;
  }
};

export const WebsiteAssetService = {
  requestBrandUploadSignature,
  finalizeBrandUpload,
};
