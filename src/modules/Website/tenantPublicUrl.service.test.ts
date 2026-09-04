import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, entitlementMock, env } = vi.hoisted(() => ({
  prismaMock: { businessWebsite: { findUnique: vi.fn() } },
  entitlementMock: { getForAdminId: vi.fn() },
  env: { customDomainsEnabled: true },
}));

vi.mock("../../config/ENV", () => ({
  WEBSITE_BASE_DOMAIN: "cleaning.example.com",
  get WEBSITE_CUSTOM_DOMAINS_ENABLED() { return env.customDomainsEnabled; },
}));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("./websiteDomainReadiness", () => ({
  readyWebsiteDomainWhere: {
    status: "VERIFIED", ownershipVerified: true, providerVerified: true,
    routingVerified: true, tlsStatus: { in: ["READY", "EXTERNAL"] },
  },
}));
vi.mock("./websiteEntitlement.service", () => ({
  WebsiteEntitlementService: entitlementMock,
}));

import { TenantPublicUrlService } from "./tenantPublicUrl.service";

const website = (domain: string | null) => ({
  id: "11111111-1111-4111-8111-111111111111",
  subdomain: "softriple-4",
  domains: domain ? [{ domain }] : [],
});

beforeEach(() => {
  vi.clearAllMocks();
  env.customDomainsEnabled = true;
  entitlementMock.getForAdminId.mockResolvedValue({ customDomains: true, customDomainLimit: 1 });
});

describe("TenantPublicUrlService", () => {
  it("uses the routing-ready primary custom domain when canonical entitlements allow it", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue(website("www.softriplecleaning.com"));
    const result = await TenantPublicUrlService.resolveForAdminId("admin-1");

    expect(entitlementMock.getForAdminId).toHaveBeenCalledWith("admin-1");
    expect(prismaMock.businessWebsite.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { adminId: "admin-1" },
        select: expect.objectContaining({
          domains: expect.objectContaining({
            where: expect.objectContaining({
              isPrimary: true, status: "VERIFIED", ownershipVerified: true,
              providerVerified: true, routingVerified: true,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual({
      websiteId: "11111111-1111-4111-8111-111111111111",
      subdomain: "softriple-4",
      customDomain: "www.softriplecleaning.com",
      origin: "https://www.softriplecleaning.com",
    });
  });

  it("falls back to the free subdomain when no ready primary custom domain exists", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue(website(null));
    const result = await TenantPublicUrlService.resolveForAdminId("admin-1");
    expect(result.customDomain).toBeNull();
    expect(result.origin).toBe("https://softriple-4.cleaning.example.com");
  });

  it("falls back to the free subdomain when custom domains are disabled by effective entitlement", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue(website("www.softriplecleaning.com"));
    entitlementMock.getForAdminId.mockResolvedValue({ customDomains: false, customDomainLimit: 0 });
    const result = await TenantPublicUrlService.resolveForAdminId("admin-1");
    expect(result.customDomain).toBeNull();
  });

  it("builds one normalized tenant-root document URL without double slashes", () => {
    expect(TenantPublicUrlService.buildRootDocumentUrl(
      { origin: "https://softriple-4.cleaning.example.com/" }, "abc_DEF-123",
    )).toBe("https://softriple-4.cleaning.example.com/abc_DEF-123");
  });
});
