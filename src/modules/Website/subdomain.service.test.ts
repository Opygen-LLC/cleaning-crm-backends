import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, hostResolverMock, projectionCacheMock } = vi.hoisted(() => {
  const tx = {
    businessWebsite: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    websiteSubdomainAlias: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
  return {
    prismaMock: {
      businessWebsite: { findUnique: vi.fn() },
      websiteSubdomainAlias: { findUnique: vi.fn(), findMany: vi.fn() },
      websiteDomain: { findMany: vi.fn() },
      $transaction: vi.fn(async (work: (value: typeof tx) => unknown) => work(tx)),
      __tx: tx,
    },
    hostResolverMock: {
      invalidateSubdomains: vi.fn(),
      invalidateHosts: vi.fn(),
      resolveHost: vi.fn(),
    },
    projectionCacheMock: { invalidateWebsite: vi.fn() },
  };
});

vi.mock("../../config/ENV", () => ({ WEBSITE_BASE_DOMAIN: "sites.example.com" }));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireTextTransactionAdvisoryLock: vi.fn(async () => undefined),
}));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn(async () => "admin-1") }));
vi.mock("./websiteProvisioning.service", () => ({ WEBSITE_SUBDOMAIN_RESERVATION_LOCK: "website-subdomain-reservation" }));
vi.mock("./websiteHostResolver.service", () => ({ WebsiteHostResolverService: hostResolverMock }));
vi.mock("./websiteProjectionCache.service", () => ({ WebsiteProjectionCacheService: projectionCacheMock }));

import { SubdomainService } from "./subdomain.service";

const user = { id: "user-1", adminId: "admin-1", email: "owner@example.com", role: "ADMIN" as any };
const tx = (prismaMock as any).__tx;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1", subdomain: "bio-cleaning" });
  prismaMock.websiteSubdomainAlias.findUnique.mockResolvedValue(null);
  prismaMock.websiteSubdomainAlias.findMany.mockResolvedValue([]);
  prismaMock.websiteDomain.findMany.mockResolvedValue([]);
  tx.businessWebsite.findUnique.mockResolvedValue({ id: "website-1", subdomain: "bio-cleaning" });
  tx.businessWebsite.update.mockResolvedValue({ id: "website-1", subdomain: "biocleaning" });
  tx.websiteSubdomainAlias.findUnique.mockResolvedValue(null);
  tx.websiteSubdomainAlias.create.mockResolvedValue({
    id: "alias-1",
    websiteId: "website-1",
    subdomain: "bio-cleaning",
    redirectCode: 308,
    createdAt: new Date("2026-08-17T00:00:00.000Z"),
  });
  hostResolverMock.invalidateSubdomains.mockResolvedValue(undefined);
  hostResolverMock.invalidateHosts.mockResolvedValue(undefined);
  hostResolverMock.resolveHost.mockResolvedValue({ websiteId: "website-1" });
  projectionCacheMock.invalidateWebsite.mockResolvedValue(undefined);
});

describe("SubdomainService", () => {
  it("reports current, occupied and reclaimable addresses without mutating routing", async () => {
    prismaMock.businessWebsite.findUnique
      .mockResolvedValueOnce({ id: "website-1", subdomain: "bio-cleaning" })
      .mockResolvedValueOnce(null);
    prismaMock.websiteSubdomainAlias.findUnique.mockResolvedValueOnce({ websiteId: "website-1" });

    const result = await SubdomainService.checkAvailability("old-bio-cleaning", user);

    expect(result).toMatchObject({
      subdomain: "old-bio-cleaning",
      available: true,
      current: false,
      reclaimableAlias: true,
      publicUrl: "https://old-bio-cleaning.sites.example.com",
    });
  });

  it("atomically makes the old free address a 308 alias and warms old/new routing", async () => {
    const result = await SubdomainService.rename("biocleaning", user);

    expect(tx.websiteSubdomainAlias.create).toHaveBeenCalledWith({
      data: {
        websiteId: "website-1",
        subdomain: "bio-cleaning",
        redirectCode: 308,
      },
    });
    expect(tx.businessWebsite.update).toHaveBeenCalledWith({
      where: { id: "website-1" },
      data: { subdomain: "biocleaning" },
    });
    expect(hostResolverMock.invalidateSubdomains).toHaveBeenCalledWith(
      expect.arrayContaining(["bio-cleaning", "biocleaning"]),
    );
    expect(projectionCacheMock.invalidateWebsite).toHaveBeenCalledWith("website-1");
    expect(hostResolverMock.resolveHost).toHaveBeenCalledWith("bio-cleaning.sites.example.com");
    expect(hostResolverMock.resolveHost).toHaveBeenCalledWith("biocleaning.sites.example.com");
    expect(result).toMatchObject({
      changed: true,
      subdomain: "biocleaning",
      previousSubdomain: "bio-cleaning",
      redirectCode: 308,
      publicUrl: "https://biocleaning.sites.example.com",
      previousPublicUrl: "https://bio-cleaning.sites.example.com",
      alias: { subdomain: "bio-cleaning", redirectCode: 308 },
    });
  });

  it("rejects another tenant's current or historical address inside the reservation lock", async () => {
    tx.websiteSubdomainAlias.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.subdomain === "taken-cleaning") return { id: "alias-foreign", websiteId: "website-2" };
      return null;
    });

    await expect(SubdomainService.rename("taken-cleaning", user)).rejects.toMatchObject({ statusCode: 409 });
    expect(tx.businessWebsite.update).not.toHaveBeenCalled();
    expect(tx.websiteSubdomainAlias.create).not.toHaveBeenCalled();
  });

  it("can reclaim its own old alias without creating an alias chain", async () => {
    tx.websiteSubdomainAlias.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.subdomain === "bio-cleaning-old") return { id: "alias-old", websiteId: "website-1" };
      return null;
    });

    await SubdomainService.rename("bio-cleaning-old", user);

    expect(tx.websiteSubdomainAlias.delete).toHaveBeenCalledWith({ where: { id: "alias-old" } });
    expect(tx.websiteSubdomainAlias.create).toHaveBeenCalledWith({
      data: { websiteId: "website-1", subdomain: "bio-cleaning", redirectCode: 308 },
    });
    expect(tx.businessWebsite.update).toHaveBeenCalledWith({
      where: { id: "website-1" },
      data: { subdomain: "bio-cleaning-old" },
    });
  });
});
