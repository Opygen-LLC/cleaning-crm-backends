import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  uploadFromServer: vi.fn(),
  bindReadyAsset: vi.fn(),
  deleteAssetForTenant: vi.fn(),
  getAdminId: vi.fn(),
  invalidateRuntimeAuth: vi.fn(),
  invalidatePrivate: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock("../Media/media.service", () => ({
  mediaService: {
    uploadFromServer: mocks.uploadFromServer,
    bindReadyAsset: mocks.bindReadyAsset,
    deleteAssetForTenant: mocks.deleteAssetForTenant,
  },
}));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: mocks.getAdminId }));
vi.mock("../../lib/cache/authRuntimeCache", () => ({ invalidateRuntimeAuth: mocks.invalidateRuntimeAuth }));
vi.mock("../../middlewares/privateResponseCache", () => ({ invalidatePrivateResponseCacheForUser: mocks.invalidatePrivate }));
vi.mock("../Auth/sessionSecurity.service", () => ({ revokeAllSessionsForUser: vi.fn() }));
vi.mock("../Media/imageOptimizer", () => ({ optimizeImage: vi.fn() }));
vi.mock("../../lib/storage/r2Storage.service", () => ({ r2StorageService: { putObject: vi.fn(), publicUrl: vi.fn() } }));

import { UserRole } from "../../generated/prisma/enums";
import { userService } from "./user.service";

const adminRequester = { id: "user-1", role: UserRole.ADMIN } as never;

describe("userService R2 avatar uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminId.mockResolvedValue("admin-1");
    mocks.invalidatePrivate.mockResolvedValue(undefined);
  });

  it("rejects an invalid MIME before touching persistence", async () => {
    await expect(userService.uploadMyAvatar(adminRequester, Buffer.from("pdf"), "application/pdf"))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.uploadFromServer).not.toHaveBeenCalled();
  });

  it("uploads a supported image through MediaService, persists the media reference, and clears caches", async () => {
    mocks.findUnique.mockResolvedValue({ id: "user-1", role: UserRole.ADMIN, imageMediaAssetId: null });
    mocks.uploadFromServer.mockResolvedValue({ id: "asset-new", publicUrl: "https://media.example.com/avatar.webp" });
    mocks.update.mockResolvedValue({ id: "user-1" });

    await expect(userService.uploadMyAvatar(adminRequester, Buffer.from("image"), "image/webp", "avatar.webp"))
      .resolves.toEqual({ avatarUrl: "https://media.example.com/avatar.webp" });

    expect(mocks.uploadFromServer).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "USER_AVATAR",
        entityId: "user-1",
        filename: "avatar.webp",
        contentType: "image/webp",
      }),
      adminRequester,
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { image: "https://media.example.com/avatar.webp", imageMediaAssetId: "asset-new" },
    });
    expect(mocks.invalidateRuntimeAuth).toHaveBeenCalledWith("user-1");
    expect(mocks.invalidatePrivate).toHaveBeenCalledWith("user-1");
  });

  it("attaches a finalized direct-upload asset and removes the previous tenant asset after persistence", async () => {
    mocks.findUnique.mockResolvedValue({ imageMediaAssetId: "asset-old" });
    mocks.bindReadyAsset.mockResolvedValue({ id: "asset-new", publicUrl: "https://media.example.com/new.webp" });
    mocks.update.mockResolvedValue({ id: "user-1" });

    await expect(userService.attachMyAvatarAsset(adminRequester, "asset-new"))
      .resolves.toEqual({ avatarUrl: "https://media.example.com/new.webp" });

    expect(mocks.bindReadyAsset).toHaveBeenCalledWith("asset-new", adminRequester, "USER_AVATAR", "user-1");
    expect(mocks.deleteAssetForTenant).toHaveBeenCalledWith("asset-old", "admin-1");
  });
});
