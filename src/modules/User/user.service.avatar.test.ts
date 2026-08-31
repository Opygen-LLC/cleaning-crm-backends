import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  upload: vi.fn(),
  invalidateRuntimeAuth: vi.fn(),
  invalidatePrivate: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock("../../lib/utils/cloudinary", () => ({ uploadToCloudinary: mocks.upload }));
vi.mock("../../lib/cache/authRuntimeCache", () => ({ invalidateRuntimeAuth: mocks.invalidateRuntimeAuth }));
vi.mock("../../middlewares/privateResponseCache", () => ({ invalidatePrivateResponseCacheForUser: mocks.invalidatePrivate }));
vi.mock("../Auth/sessionSecurity.service", () => ({ revokeAllSessionsForUser: vi.fn() }));

import { userService } from "./user.service";

describe("userService.uploadMyAvatar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid MIME before touching persistence", async () => {
    await expect(userService.uploadMyAvatar("user-1", Buffer.from("pdf"), "application/pdf"))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("uploads a supported image, persists URL and clears user caches", async () => {
    mocks.findUnique.mockResolvedValue({ id: "user-1" });
    mocks.upload.mockResolvedValue({ secure_url: "https://cdn.example.com/avatar.webp" });
    mocks.update.mockResolvedValue({ id: "user-1" });
    mocks.invalidatePrivate.mockResolvedValue(undefined);

    await expect(userService.uploadMyAvatar("user-1", Buffer.from("image"), "image/webp"))
      .resolves.toEqual({ avatarUrl: "https://cdn.example.com/avatar.webp" });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { image: "https://cdn.example.com/avatar.webp" },
    });
    expect(mocks.invalidateRuntimeAuth).toHaveBeenCalledWith("user-1");
    expect(mocks.invalidatePrivate).toHaveBeenCalledWith("user-1");
  });
});
