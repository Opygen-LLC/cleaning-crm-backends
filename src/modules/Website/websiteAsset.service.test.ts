import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, getAdminIdMock, websiteServiceMock, cloudinaryMock } = vi.hoisted(() => ({
  prismaMock: { businessWebsite: { findUnique: vi.fn() } },
  getAdminIdMock: vi.fn(),
  websiteServiceMock: { attachManagedBrandAsset: vi.fn() },
  cloudinaryMock: {
    utils: { api_sign_request: vi.fn() },
    api: { resource: vi.fn() },
    uploader: { destroy: vi.fn() },
    url: vi.fn(),
  },
}));

vi.mock("../../config/ENV", () => ({
  CLOUDINARY_CLOUD_NAME: "demo-cloud",
  CLOUDINARY_API_KEY: "public-key",
  CLOUDINARY_API_SECRET: "private-secret",
}));
vi.mock("../../config/cloudinary", () => ({ cloudinaryUpload: cloudinaryMock }));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: getAdminIdMock }));
vi.mock("./website.service", () => ({ WebsiteService: websiteServiceMock }));

import { WebsiteAssetService } from "./websiteAsset.service";

beforeEach(() => {
  vi.clearAllMocks();
  getAdminIdMock.mockResolvedValue("admin-1");
  prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1", status: "PUBLISHED" });
  cloudinaryMock.utils.api_sign_request.mockReturnValue("signed-value");
  cloudinaryMock.url.mockImplementation((publicId: string, options: any) =>
    `https://cdn.example/${publicId}/${options.format}/${options.transformation?.[0]?.width}`,
  );
  websiteServiceMock.attachManagedBrandAsset.mockImplementation(async (payload: any) => ({
    asset: { id: "asset-1", ...payload },
    website: { id: "website-1", logo: payload.kind === "logo" ? payload.url : null },
  }));
});

describe("WebsiteAssetService signed brand uploads", () => {
  it("issues a short-lived tenant-scoped signed Cloudinary upload", async () => {
    const result = await WebsiteAssetService.requestBrandUploadSignature({
      kind: "logo",
      fileName: "bio-cleaning.png",
      mimeType: "image/png",
      bytes: 250_000,
    }, { id: "user-1" } as never);

    expect(result.publicId).toMatch(/^Cleaning-CRM\/websites\/website-1\/brand\/logo-/);
    expect(result.uploadUrl).toBe("https://api.cloudinary.com/v1_1/demo-cloud/image/upload");
    expect(result.fields.signature).toBe("signed-value");
    expect(result.fields.context).toContain("website_id=website-1");
    expect(result.fields.eager).toContain("f_webp");
    expect(result.fields.eager).toContain("f_avif");
  });

  it("verifies provider metadata and persists immutable responsive variants", async () => {
    const publicId = "Cleaning-CRM/websites/website-1/brand/logo-upload-token";
    cloudinaryMock.api.resource.mockResolvedValue({
      public_id: publicId,
      secure_url: "https://res.cloudinary.com/demo/image/upload/logo.png",
      format: "png",
      width: 800,
      height: 300,
      bytes: 180_000,
      context: {
        custom: {
          website_id: "website-1",
          asset_kind: "logo",
          expires_at: String(Math.floor(Date.now() / 1000) + 300),
        },
      },
    });

    const result = await WebsiteAssetService.finalizeBrandUpload({ kind: "logo", publicId }, { id: "user-1" } as never);

    expect(websiteServiceMock.attachManagedBrandAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "logo",
        publicId,
        width: 800,
        height: 300,
        metadata: expect.objectContaining({ provider: "cloudinary", kind: "brand", immutable: true }),
      }),
      expect.anything(),
    );
    const persisted = websiteServiceMock.attachManagedBrandAsset.mock.calls[0][0];
    expect(persisted.metadata.variants.webp[512]).toContain("/webp/512");
    expect(persisted.metadata.variants.avif[512]).toContain("/avif/512");
    expect(result.asset.id).toBe("asset-1");
  });

  it("rejects cross-tenant public IDs before reading Cloudinary", async () => {
    await expect(WebsiteAssetService.finalizeBrandUpload({
      kind: "logo",
      publicId: "Cleaning-CRM/websites/website-2/brand/logo-stolen",
    }, { id: "user-1" } as never)).rejects.toThrow("does not belong");
    expect(cloudinaryMock.api.resource).not.toHaveBeenCalled();
  });

  it("rejects non-square favicons and cleans up the rejected provider asset", async () => {
    const publicId = "Cleaning-CRM/websites/website-1/brand/favicon-upload-token";
    cloudinaryMock.api.resource.mockResolvedValue({
      public_id: publicId,
      secure_url: "https://res.cloudinary.com/demo/image/upload/favicon.png",
      format: "png",
      width: 256,
      height: 100,
      bytes: 20_000,
      context: {
        custom: {
          website_id: "website-1",
          asset_kind: "favicon",
          expires_at: String(Math.floor(Date.now() / 1000) + 300),
        },
      },
    });

    await expect(WebsiteAssetService.finalizeBrandUpload({ kind: "favicon", publicId }, { id: "user-1" } as never))
      .rejects.toThrow("approximately square");
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith(publicId, expect.objectContaining({ invalidate: true }));
  });
});
