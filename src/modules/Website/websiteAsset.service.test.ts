import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, getAdminIdMock, websiteServiceMock, entitlementMock, mediaMock } = vi.hoisted(() => ({
  prismaMock: {
    businessWebsite: { findUnique: vi.fn() },
  },
  getAdminIdMock: vi.fn(),
  websiteServiceMock: { attachManagedBrandAsset: vi.fn() },
  entitlementMock: { getForAdminId: vi.fn() },
  mediaMock: {
    initiateUpload: vi.fn(),
    bindReadyAsset: vi.fn(),
  },
}));

vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: getAdminIdMock }));
vi.mock("./website.service", () => ({ WebsiteService: websiteServiceMock }));
vi.mock("./websiteEntitlement.service", () => ({ WebsiteEntitlementService: entitlementMock }));
vi.mock("../Media/media.service", () => ({ mediaService: mediaMock }));

import { WebsiteAssetService } from "./websiteAsset.service";

const requester = { id: "user-1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  getAdminIdMock.mockResolvedValue("admin-1");
  prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1", status: "DRAFT" });
  entitlementMock.getForAdminId.mockResolvedValue({ advancedSeo: true });
  mediaMock.initiateUpload.mockResolvedValue({
    uploadId: "asset-pending",
    uploadUrl: "https://signed-r2.example/upload",
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    expiresAt: "2026-09-10T12:00:00.000Z",
  });
  mediaMock.bindReadyAsset.mockResolvedValue({
    id: "asset-ready",
    objectKey: "organizations/admin-1/website/website-1/brand/uuid.webp",
    publicUrl: "https://media.example.com/organizations/admin-1/website/website-1/brand/uuid.webp",
    mimeType: "image/webp",
    width: 800,
    height: 300,
    storedBytes: 100_000,
    originalBytes: 250_000,
  });
  websiteServiceMock.attachManagedBrandAsset.mockImplementation(async (payload: any) => ({
    asset: { id: "website-asset-1", ...payload },
    website: { id: "website-1", logo: payload.kind === "logo" ? payload.url : null },
  }));
});

describe("WebsiteAssetService R2 brand uploads", () => {
  it("issues a short-lived tenant-scoped R2 PUT session", async () => {
    const result = await WebsiteAssetService.requestBrandUploadSignature({
      kind: "logo",
      fileName: "bio-cleaning.png",
      mimeType: "image/png",
      bytes: 250_000,
    }, requester);

    expect(mediaMock.initiateUpload).toHaveBeenCalledWith({
      purpose: "WEBSITE_BRAND",
      entityId: "website-1",
      filename: "bio-cleaning.png",
      contentType: "image/png",
      size: 250_000,
    }, requester);
    expect(result.provider).toBe("r2");
    expect(result.kind).toBe("logo");
    expect(result.uploadUrl).toBe("https://signed-r2.example/upload");
  });

  it("binds a finalized tenant asset and persists immutable R2 metadata", async () => {
    const result = await WebsiteAssetService.finalizeBrandUpload({ kind: "logo", mediaAssetId: "asset-ready" }, requester);

    expect(mediaMock.bindReadyAsset).toHaveBeenCalledWith("asset-ready", requester, "WEBSITE_BRAND", "website-1");
    expect(websiteServiceMock.attachManagedBrandAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "logo",
        mediaAssetId: "asset-ready",
        publicId: "organizations/admin-1/website/website-1/brand/uuid.webp",
        url: "https://media.example.com/organizations/admin-1/website/website-1/brand/uuid.webp",
        width: 800,
        height: 300,
        metadata: expect.objectContaining({ provider: "r2", mediaAssetId: "asset-ready", kind: "brand", immutable: true }),
      }),
      requester,
    );
    expect(result.id).toBe("website-asset-1");
  });

  it("rejects an asset whose dimensions do not match favicon requirements", async () => {
    mediaMock.bindReadyAsset.mockResolvedValue({
      id: "asset-favicon",
      objectKey: "organizations/admin-1/website/website-1/brand/favicon.webp",
      publicUrl: "https://media.example.com/favicon.webp",
      mimeType: "image/webp",
      width: 256,
      height: 100,
      storedBytes: 20_000,
      originalBytes: 25_000,
    });

    await expect(WebsiteAssetService.finalizeBrandUpload({ kind: "favicon", mediaAssetId: "asset-favicon" }, requester))
      .rejects.toThrow("approximately square");
    expect(websiteServiceMock.attachManagedBrandAsset).not.toHaveBeenCalled();
  });

  it("rejects social-image uploads when Advanced Website SEO is unavailable", async () => {
    entitlementMock.getForAdminId.mockResolvedValue({ advancedSeo: false });

    await expect(WebsiteAssetService.requestBrandUploadSignature({
      kind: "social",
      fileName: "share.png",
      mimeType: "image/png",
      bytes: 200_000,
    }, requester)).rejects.toMatchObject({ statusCode: 403 });
    expect(mediaMock.initiateUpload).not.toHaveBeenCalled();
  });

  it("rejects portrait social images before mutating Website Studio state", async () => {
    mediaMock.bindReadyAsset.mockResolvedValue({
      id: "asset-social",
      objectKey: "organizations/admin-1/website/website-1/brand/social.webp",
      publicUrl: "https://media.example.com/social.webp",
      mimeType: "image/webp",
      width: 800,
      height: 1000,
      storedBytes: 200_000,
      originalBytes: 220_000,
    });

    await expect(WebsiteAssetService.finalizeBrandUpload({ kind: "social", mediaAssetId: "asset-social" }, requester))
      .rejects.toThrow("landscape aspect ratio");
    expect(websiteServiceMock.attachManagedBrandAsset).not.toHaveBeenCalled();
  });
});
