import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserRole } from "../../generated/prisma/enums";
import type { IRequestUser } from "../../types/requestUser.interface";

const mocks = vi.hoisted(() => ({
  serviceCatalogFindUnique: vi.fn(),
  mediaAssetCreate: vi.fn(),
  createUploadUrl: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    serviceCatalog: { findUnique: mocks.serviceCatalogFindUnique },
    staffProfile: { findUnique: vi.fn() },
    businessWebsite: { findUnique: vi.fn() },
    job: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn() },
    payment: { findUnique: vi.fn() },
    expense: { findUnique: vi.fn() },
    subscription: { findUnique: vi.fn() },
    mediaAsset: {
      create: mocks.mediaAssetCreate,
      delete: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn(async () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") }));
vi.mock("../../lib/storage/r2Storage.service", () => ({
  r2StorageService: {
    createUploadUrl: mocks.createUploadUrl,
    headObject: vi.fn(),
    getObjectBuffer: vi.fn(),
    getObjectPrefix: vi.fn(),
    putObject: vi.fn(),
    copyObject: vi.fn(),
    deleteObject: vi.fn(),
    createPrivateDownloadUrl: vi.fn(),
    publicUrl: vi.fn(),
    probe: vi.fn(),
  },
}));

import { mediaService } from "./media.service";

const adminUser: IRequestUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  role: UserRole.ADMIN,
  adminId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

const staffUser: IRequestUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "staff@example.com",
  role: UserRole.STAFF,
  adminId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("mediaService tenant/purpose isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a service entity owned by another organization before creating an upload", async () => {
    mocks.serviceCatalogFindUnique.mockResolvedValue({ adminId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

    await expect(mediaService.initiateUpload({
      purpose: "SERVICE_IMAGE",
      entityId: "33333333-3333-4333-8333-333333333333",
      filename: "service.jpg",
      contentType: "image/jpeg",
      size: 1000,
    }, adminUser)).rejects.toMatchObject({ code: "MEDIA_ENTITY_NOT_FOUND" });

    expect(mocks.mediaAssetCreate).not.toHaveBeenCalled();
    expect(mocks.createUploadUrl).not.toHaveBeenCalled();
  });

  it("does not allow staff to upload organization branding", async () => {
    await expect(mediaService.initiateUpload({
      purpose: "BUSINESS_LOGO",
      filename: "logo.png",
      contentType: "image/png",
      size: 1000,
    }, staffUser)).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.mediaAssetCreate).not.toHaveBeenCalled();
  });
});
