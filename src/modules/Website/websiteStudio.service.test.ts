import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, websiteServiceMock, getAdminIdMock, templateRegistryMock } = vi.hoisted(() => ({
  prismaMock: {
    adminProfile: { findUnique: vi.fn() },
    bookingForm: { findMany: vi.fn() },
    estimateForm: { findMany: vi.fn() },
  },
  websiteServiceMock: { getWebsiteForAdmin: vi.fn() },
  getAdminIdMock: vi.fn(),
  templateRegistryMock: { list: vi.fn() },
}));

vi.mock("../../config/ENV", () => ({ WEBSITE_CUSTOM_DOMAINS_ENABLED: true }));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: getAdminIdMock }));
vi.mock("./website.service", () => ({ WebsiteService: websiteServiceMock }));
vi.mock("./templateRegistry", () => ({ TemplateRegistry: templateRegistryMock }));

import { WebsiteStudioService } from "./websiteStudio.service";

beforeEach(() => {
  vi.clearAllMocks();
  getAdminIdMock.mockResolvedValue("admin-1");
  websiteServiceMock.getWebsiteForAdmin.mockResolvedValue({
    id: "website-1",
    adminId: "admin-1",
    subdomain: "bio-cleaning",
    status: "PUBLISHED",
  });
  prismaMock.adminProfile.findUnique.mockResolvedValue({
    businessName: "Bio Cleaning",
    businessWebsite: { status: "PUBLISHED", publishedSnapshot: null },
  });
  prismaMock.bookingForm.findMany.mockResolvedValue([]);
  prismaMock.estimateForm.findMany.mockResolvedValue([]);
  templateRegistryMock.list.mockReturnValue([{ id: "clean-modern", version: "1.0.0" }]);
});

describe("WebsiteStudioService.getStudio", () => {
  it("returns the business display name with the single Website workspace bootstrap", async () => {
    const result = await WebsiteStudioService.getStudio({ id: "user-1" } as never);

    expect(result.business).toEqual({ name: "Bio Cleaning" });
    expect(result.website).toEqual(expect.objectContaining({ id: "website-1", subdomain: "bio-cleaning" }));
    expect(result.features.customDomainsEnabled).toBe(true);
    expect(prismaMock.adminProfile.findUnique).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      select: {
        businessName: true,
        businessWebsite: { select: { status: true, publishedSnapshot: true } },
      },
    });
  });

  it("uses a safe label when a legacy profile has a blank business name", async () => {
    prismaMock.adminProfile.findUnique.mockResolvedValue({ businessName: "   ", businessWebsite: null });

    const result = await WebsiteStudioService.getStudio({ id: "user-1" } as never);

    expect(result.business.name).toBe("Your cleaning business");
  });
});
