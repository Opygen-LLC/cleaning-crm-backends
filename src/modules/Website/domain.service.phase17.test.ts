import { promises as dns } from "node:dns";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, redisMock, providerMock, hostResolverMock, projectionMock, entitlementMock } = vi.hoisted(() => ({
  prismaMock: {
    businessWebsite: { findUnique: vi.fn() },
    websiteDomain: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    websiteSubdomainAlias: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  redisMock: { set: vi.fn(), eval: vi.fn() },
  providerMock: { assertConfigured: vi.fn(), verify: vi.fn(), detach: vi.fn(), describeProviderError: vi.fn() },
  hostResolverMock: { invalidateSubdomains: vi.fn(), invalidateHosts: vi.fn(), resolveHost: vi.fn() },
  projectionMock: { invalidateWebsite: vi.fn() },
  entitlementMock: {
    getForUser: vi.fn(),
    assertCustomDomainsAllowed: vi.fn(),
  },
}));

vi.mock("../../config/ENV", () => ({
  WEBSITE_BASE_DOMAIN: "sites.example.com",
  WEBSITE_CNAME_TARGET: "cname.example.net",
  WEBSITE_CUSTOM_DOMAINS_ENABLED: true,
  WEBSITE_CUSTOM_DOMAIN_LIMIT_PER_SITE: 10,
  WEBSITE_DOMAIN_PROVIDER: "vercel",
  WEBSITE_DOMAIN_VERIFY_LOCK_SECONDS: 90,
}));
vi.mock("../../config/redis", () => ({ default: redisMock }));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/prisma/advisoryLock", () => ({ acquireTextTransactionAdvisoryLock: vi.fn() }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn().mockResolvedValue("admin-1") }));
vi.mock("./websiteDomainProvider.service", () => ({ WebsiteDomainProviderService: providerMock }));
vi.mock("./websiteHostResolver.service", () => ({ WebsiteHostResolverService: hostResolverMock }));
vi.mock("./websiteProjectionCache.service", () => ({ WebsiteProjectionCacheService: projectionMock }));
vi.mock("./websiteEntitlement.service", () => ({ WebsiteEntitlementService: entitlementMock }));

import { DomainService } from "./domain.service";

const initialDomain = {
  id: "domain-1",
  websiteId: "website-1",
  domain: "www.biocleaning.co.uk",
  status: "PENDING",
  verificationToken: "ownership-token",
  requiredDns: {},
  isPrimary: false,
  provider: "VERCEL",
  providerVerified: false,
  ownershipVerified: false,
  routingVerified: false,
  tlsStatus: "PENDING",
  lastProviderSyncAt: null,
  verificationStartedAt: null,
  providerData: {},
  lastCheckedAt: null,
  verifiedAt: null,
  failureReason: null,
  createdAt: new Date("2026-08-17T00:00:00Z"),
  updatedAt: new Date("2026-08-17T00:00:00Z"),
};

const activeDomain = {
  ...initialDomain,
  status: "VERIFIED",
  ownershipVerified: true,
  providerVerified: true,
  routingVerified: true,
  tlsStatus: "READY",
  lastProviderSyncAt: new Date("2026-08-17T01:00:00Z"),
  verifiedAt: new Date("2026-08-17T01:00:00Z"),
  failureReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1", subdomain: "bio-cleaning" });
  prismaMock.$transaction.mockImplementation(async (work: (tx: typeof prismaMock) => Promise<unknown>) => work(prismaMock));
  prismaMock.websiteSubdomainAlias.findMany.mockResolvedValue([]);
  prismaMock.websiteDomain.findMany.mockResolvedValue([{ ...activeDomain, isPrimary: true }]);
  prismaMock.websiteDomain.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.websiteDomain.update.mockImplementation(async ({ data }: any) =>
    data?.isPrimary === true ? { ...activeDomain, isPrimary: true } : { ...activeDomain, ...data },
  );
  prismaMock.websiteDomain.findUnique.mockImplementation(async ({ where }: any) =>
    where?.id === activeDomain.id ? activeDomain : null,
  );
  let ownedReadCount = 0;
  prismaMock.websiteDomain.findFirst.mockImplementation(async ({ where }: any) => {
    if (where?.isPrimary === true) return null;
    if (where?.id === activeDomain.id && where?.status === "VERIFIED") return activeDomain;
    if (where?.id === activeDomain.id) {
      ownedReadCount += 1;
      return ownedReadCount <= 2 ? initialDomain : activeDomain;
    }
    return null;
  });
  redisMock.set.mockResolvedValue("OK");
  redisMock.eval.mockResolvedValue(1);
  providerMock.verify.mockResolvedValue({
    provider: "VERCEL",
    attached: true,
    verified: true,
    routingConfigured: true,
    tlsStatus: "READY",
    dnsRecords: [{ type: "CNAME", host: activeDomain.domain, value: "cname.example.net", purpose: "routing" }],
    message: null,
    providerData: { tlsProbeOk: true },
  });
  hostResolverMock.invalidateSubdomains.mockResolvedValue(undefined);
  hostResolverMock.invalidateHosts.mockResolvedValue(undefined);
  hostResolverMock.resolveHost.mockResolvedValue({});
  projectionMock.invalidateWebsite.mockResolvedValue(undefined);
  entitlementMock.getForUser.mockResolvedValue({
    planName: "PRO",
    basicWebsite: true,
    freeSubdomain: true,
    onlineBooking: true,
    customDomains: true,
    customDomainLimit: 3,
    premiumTemplates: true,
    analyticsHistoryDays: 365,
    advancedSeo: true,
  });
  vi.spyOn(dns, "resolveTxt").mockResolvedValue([["ownership-token"]]);
});

describe("Phase 17 custom-domain verification", () => {
  it("automatically promotes the first fully active custom domain to canonical", async () => {
    const result = await DomainService.verifyDomain("domain-1", { id: "user-1" } as any);

    expect(result.lifecycle.status).toBe("ACTIVE");
    expect(result.isPrimary).toBe(true);
    expect(result.lifecycle.publicUrl).toBe("https://www.biocleaning.co.uk");
    expect(prismaMock.websiteDomain.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "domain-1" }, data: { isPrimary: true } }),
    );
    expect(hostResolverMock.invalidateHosts).toHaveBeenCalled();
    expect(hostResolverMock.resolveHost).toHaveBeenCalledWith("www.biocleaning.co.uk");
    expect(result.routingState.canonicalUrl).toBe("https://www.biocleaning.co.uk");
  });
  it("keeps an already-active custom domain live during a transient provider recheck failure", async () => {
    const live = { ...activeDomain, isPrimary: true };
    prismaMock.websiteDomain.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.isPrimary === true) return live;
      if (where?.id === live.id) return live;
      return null;
    });
    prismaMock.websiteDomain.findUnique.mockResolvedValue(live);
    prismaMock.websiteDomain.update.mockImplementation(async ({ data }: any) => ({ ...live, ...data }));
    providerMock.verify.mockRejectedValue(new Error("provider timeout"));
    providerMock.describeProviderError.mockReturnValue("Hosting provider status check timed out");

    const result = await DomainService.verifyDomain("domain-1", { id: "user-1" } as any);

    expect(result.lifecycle.status).toBe("ACTIVE");
    expect(result.isPrimary).toBe(true);
    expect(result.failureReason).toContain("Existing verified routing remains active");
    expect(prismaMock.websiteDomain.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "domain-1" },
      data: expect.objectContaining({
        status: "VERIFIED",
        verificationStartedAt: null,
      }),
    }));
  });

});
