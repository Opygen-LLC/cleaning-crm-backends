import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { prisma } from "../../lib/prisma/prisma";
import type { IRequestUser } from "../../types/requestUser.interface";
import type {
  WebsiteBrandAssetKind,
  WebsiteBrandUploadFinalizeInput,
  WebsiteBrandUploadSignatureInput,
} from "./website.interface";
import { WebsiteService } from "./website.service";
import { WebsiteEntitlementService } from "./websiteEntitlement.service";
import { mediaService } from "../Media/media.service";

const LIMITS: Record<WebsiteBrandAssetKind, { maxBytes: number; maxWidth: number; maxHeight: number; minWidth: number; minHeight: number }> = {
  logo: { maxBytes: 5 * 1024 * 1024, maxWidth: 1600, maxHeight: 1600, minWidth: 64, minHeight: 24 },
  favicon: { maxBytes: 2 * 1024 * 1024, maxWidth: 512, maxHeight: 512, minWidth: 32, minHeight: 32 },
  social: { maxBytes: 5 * 1024 * 1024, maxWidth: 4000, maxHeight: 3000, minWidth: 600, minHeight: 315 },
};

const assertWebsiteCanUpload = async (kind: WebsiteBrandAssetKind, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const [website, entitlements] = await Promise.all([
    prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true, status: true } }),
    WebsiteEntitlementService.getForAdminId(adminId),
  ]);
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  if (website.status === "SUSPENDED") throw new AppError(status.CONFLICT, "A suspended website cannot upload branding assets");
  if (kind === "social" && !entitlements.advancedSeo) {
    throw new AppError(status.FORBIDDEN, "Social share image uploads require Advanced Website SEO.", { code: "WEBSITE_ADVANCED_SEO_REQUIRED", retryable: false });
  }
  return { adminId, website };
};

const assertDimensions = (kind: WebsiteBrandAssetKind, asset: { width: number | null; height: number | null; storedBytes: number | null }) => {
  const width = Number(asset.width ?? 0);
  const height = Number(asset.height ?? 0);
  const bytes = Number(asset.storedBytes ?? 0);
  const limit = LIMITS[kind];
  const label = kind === "logo" ? "Logo" : kind === "favicon" ? "Favicon" : "Social share image";
  if (!width || !height || width < limit.minWidth || height < limit.minHeight) throw new AppError(status.BAD_REQUEST, `${label} dimensions are too small`);
  if (width > limit.maxWidth || height > limit.maxHeight) throw new AppError(status.BAD_REQUEST, `${label} dimensions are too large`);
  if (!bytes || bytes > limit.maxBytes) throw new AppError(status.BAD_REQUEST, `${label} file is too large`);
  const ratio = width / height;
  if (kind === "favicon" && (ratio < 0.8 || ratio > 1.25)) throw new AppError(status.BAD_REQUEST, "Favicon must be approximately square");
  if (kind === "logo" && (ratio < 0.1 || ratio > 10)) throw new AppError(status.BAD_REQUEST, "Logo aspect ratio is not supported");
  if (kind === "social" && (ratio < 1.35 || ratio > 2.2)) throw new AppError(status.BAD_REQUEST, "Social share image should use a landscape aspect ratio close to 1200x630");
};

/**
 * Compatibility endpoint for older Studio builds. It now issues an R2 PUT
 * session instead of a provider-specific signed POST. New clients use /media directly.
 */
const requestBrandUploadSignature = async (input: WebsiteBrandUploadSignatureInput, user: IRequestUser) => {
  const { website } = await assertWebsiteCanUpload(input.kind, user);
  const limit = LIMITS[input.kind];
  if (input.bytes <= 0 || input.bytes > limit.maxBytes) throw new AppError(status.BAD_REQUEST, "Image file is too large");
  const session = await mediaService.initiateUpload({
    purpose: "WEBSITE_BRAND",
    entityId: website.id,
    filename: input.fileName,
    contentType: input.mimeType,
    size: input.bytes,
  }, user);
  return { ...session, kind: input.kind, provider: "r2" as const };
};

const finalizeBrandUpload = async (input: WebsiteBrandUploadFinalizeInput, user: IRequestUser) => {
  const { adminId, website } = await assertWebsiteCanUpload(input.kind, user);
  const asset = await mediaService.bindReadyAsset(input.mediaAssetId, user, "WEBSITE_BRAND", website.id);
  if (!asset.publicUrl) throw new AppError(status.CONFLICT, "Website image is not publicly available yet.", { code: "MEDIA_NOT_READY", retryable: true });
  assertDimensions(input.kind, asset);

  try {
    const result = await WebsiteService.attachManagedBrandAsset({
      kind: input.kind,
      publicId: asset.objectKey,
      mediaAssetId: asset.id,
      url: asset.publicUrl,
      mimeType: asset.mimeType,
      width: asset.width ?? 0,
      height: asset.height ?? 0,
      bytes: asset.storedBytes ?? asset.originalBytes,
      folder: `website/${website.id}/brand`,
      metadata: { provider: "r2", mediaAssetId: asset.id, kind: "brand", slot: input.kind, immutable: true },
    }, user);
    return result.asset;
  } catch (error) {
    await mediaService.deleteAssetIfUnreferencedForTenant(asset.id, adminId).catch(() => undefined);
    throw error;
  }
};

export const WebsiteAssetService = { requestBrandUploadSignature, finalizeBrandUpload };
