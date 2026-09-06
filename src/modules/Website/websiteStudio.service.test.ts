import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, websiteServiceMock, getAdminIdMock, templateRegistryMock, entitlementMock, overviewMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    adminProfile: { findUnique: vi.fn() },
    businessWebsite: { findUnique: vi.fn() },
  },
  websiteServiceMock: { getWebsiteForAdmin: vi.fn() },
  getAdminIdMock: vi.fn(),
  templateRegistryMock: { listSelectable: vi.fn(), requireTemplate: vi.fn() },
  entitlementMock: { getForAdminId: vi.fn() },
  overviewMock: { getForAdminId: vi.fn() },
}));

vi.mock("../../config/ENV", () => ({
  WEBSITE_BASE_DOMAIN: "sites.example.com",
  WEBSITE_CUSTOM_DOMAINS_ENABLED: true,
  WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE: 1,
  WEBSITE_DOMAIN_PROVIDER: "vercel",
}));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: getAdminIdMock }));
vi.mock("./website.service", () => ({ WebsiteService: websiteServiceMock }));
vi.mock("./templateRegistry", () => ({ TemplateRegistry: templateRegistryMock }));
vi.mock("./websiteEntitlement.service", () => ({ WebsiteEntitlementService: entitlementMock }));
vi.mock("./websiteOverview.service", () => ({ WebsiteOverviewService: overviewMock }));

import { WebsiteStudioService } from "./websiteStudio.service";

const bootstrap = (businessName: string | null = "Bio Cleaning", city: string | null = "London") => ({
  businessName,
  city,
  businessDescription: null,
  websiteStatus: "PUBLISHED",
  publishedSnapshot: null,
  bookingForms: [],
  estimateForms: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  getAdminIdMock.mockResolvedValue("admin-1");
  websiteServiceMock.getWebsiteForAdmin.mockResolvedValue({
    id: "website-1",
    adminId: "admin-1",
    subdomain: "bio-cleaning",
    status: "PUBLISHED",
    domains: [],
    publicUrl: "https://bio-cleaning.sites.example.com",
    platformUrl: "https://bio-cleaning.sites.example.com",
  });
  prismaMock.$queryRaw.mockResolvedValue([bootstrap()]);
  entitlementMock.getForAdminId.mockResolvedValue({
    customDomains: true,
    customDomainLimit: 1,
    premiumTemplates: false,
  });
  overviewMock.getForAdminId.mockResolvedValue({});
  templateRegistryMock.listSelectable.mockReturnValue([{ id: "clean-modern", version: "1.0.0", tier: "FREE" }]);
});

describe("WebsiteStudioService.getStudio", () => {
  it("loads business identity and both form lists through one bootstrap query", async () => {
    const result = await WebsiteStudioService.getStudio({ id: "user-1" } as never);

    expect(result.business).toEqual({ name: "Bio Cleaning", city: "London" });
    expect(result.seoDefaults.title).toBe("Bio Cleaning | Professional Cleaning in London");
    expect(result.website).toEqual(expect.objectContaining({ id: "website-1", subdomain: "bio-cleaning" }));
    expect(result.features.customDomainsEnabled).toBe(true);
    expect(prismaMock.$queryRaw).toHaveBeenCalledOnce();
  });

  it("uses a safe label when a legacy profile has a blank business name", async () => {
    prismaMock.$queryRaw.mockResolvedValue([bootstrap("   ", null)]);
    const result = await WebsiteStudioService.getStudio({ id: "user-1" } as never);
    expect(result.business.name).toBe("Your cleaning business");
  });
});
