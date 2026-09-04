import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, prismaMock, tenantAccessMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(),
  },
  prismaMock: {
    businessWebsite: { findUnique: vi.fn() },
    websiteSubdomainAlias: { findUnique: vi.fn() },
    websiteDomain: { findFirst: vi.fn() },
  },
  tenantAccessMock: {
    resolve: vi.fn(),
  },
}));

vi.mock("../../config/redis", () => ({ default: redisMock }));
vi.mock("../Entitlement/tenantAccessResolver.service", () => ({
  TenantAccessResolver: tenantAccessMock,
}));
vi.mock("../../config/ENV", () => ({
  WEBSITE_BASE_DOMAIN: "sites.example.com",
  WEBSITE_CUSTOM_DOMAINS_ENABLED: true,
  WEBSITE_ROUTE_CACHE_TTL_SECONDS: 300,
  WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS: 10,
  WEBSITE_ROUTE_CACHE_JITTER_RATIO: 0,
  WEBSITE_ROUTE_REBUILD_LOCK_SECONDS: 3,
  WEBSITE_ROUTE_WAIT_FOR_FILL_MS: 100,
}));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));

import { WebsiteHostResolverService } from "./websiteHostResolver.service";

const defaultAccess = (overrides: Record<string, any> = {}) => ({
  organizationId: "org-1",
  ownerUserId: "user-1",
  platform: {
    status: "ACTIVE",
    suspendedAt: null,
    archivedAt: null,
    deletionStartedAt: null,
    deletionLastAttemptAt: null,
    deletionLastError: null,
    reason: null,
  },
  subscription: {
    id: "sub-1",
    status: "ACTIVE",
    isTrial: false,
    trialEndsAt: null,
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: new Date(Date.now() + 86400000).toISOString(),
    cancelAtPeriodEnd: false,
  },
  website: {
    status: "PUBLISHED",
    published: true,
    publicAccessAllowed: true,
    deniedReason: "ACTIVE",
    ...(overrides.website ?? {}),
  },
  access: {
    dashboardAllowed: true,
    publicWebsiteAllowed: true,
    publicWritesAllowed: true,
    backgroundJobsAllowed: true,
    recoveryAllowed: true,
    deniedReason: "ACTIVE",
    ...(overrides.access ?? {}),
  },
  plan: {
    id: "plan-1",
    name: "PRO",
    pricingId: "price-1",
    features: [],
    ...(overrides.plan ?? {}),
  },
  baseEntitlements: {},
  paidExtras: { staff: 0, clients: 0, monthlyBookings: 0, storageMb: 0 },
  tenantOverrides: { active: false, expiresAt: null, reason: null, features: {}, resources: {} },
  effectiveEntitlements: {
    custom_domain: true,
    remove_branding: true,
    seo_tools: true,
    ...(overrides.effectiveEntitlements ?? {}),
  },
  resourceLimits: {
    base: {},
    afterPaidExtras: {},
    effective: {},
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.del.mockResolvedValue(1);
  redisMock.eval.mockResolvedValue(1);
  prismaMock.businessWebsite.findUnique.mockResolvedValue(null);
  prismaMock.websiteSubdomainAlias.findUnique.mockResolvedValue(null);
  prismaMock.websiteDomain.findFirst.mockResolvedValue(null);
  tenantAccessMock.resolve.mockImplementation(async () => defaultAccess());
});

describe("production tenant host routing", () => {
  it("routes the canonical free subdomain without a redirect", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-1",
      subdomain: "sparkle",
      status: "PUBLISHED",
      admin: { businessName: "Sparkle Cleaning", user: { status: "ACTIVE" }, subscription: [] },
      domains: [],
    });

    const result = await WebsiteHostResolverService.resolveHost("sparkle.sites.example.com");

    expect(result.routeKind).toBe("platform_subdomain");
    expect(result.canonicalSubdomain).toBe("sparkle");
    expect(result.canonicalHost).toBe("sparkle.sites.example.com");
    expect(result.redirectCode).toBeNull();
    expect(result.availability).toBe("live");
  });

  it("turns an old subdomain alias into one permanent redirect to the current host", async () => {
    prismaMock.websiteSubdomainAlias.findUnique.mockResolvedValue({
      websiteId: "website-1",
      website: {
        subdomain: "sparkle-london",
        status: "PUBLISHED",
        admin: { businessName: "Sparkle Cleaning", user: { status: "ACTIVE" }, subscription: [] },
        domains: [],
      },
    });

    const result = await WebsiteHostResolverService.resolveHost("sparkle.sites.example.com");

    expect(result.routeKind).toBe("subdomain_alias");
    expect(result.redirectCode).toBe(308);
    expect(result.canonicalHost).toBe("sparkle-london.sites.example.com");
  });

  it("redirects a non-primary verified custom domain to the selected canonical custom host", async () => {
    prismaMock.websiteDomain.findFirst.mockResolvedValue({
      id: "domain-old",
      websiteId: "website-1",
      domain: "old.example.com",
      status: "VERIFIED",
      isPrimary: false,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      website: {
        subdomain: "sparkle",
        status: "PUBLISHED",
        admin: { businessName: "Sparkle Cleaning", user: { status: "ACTIVE" }, subscription: [{ status: "ACTIVE", isTrial: false, currentPeriodEnd: new Date(Date.now() + 86_400_000), subscriptionPlan: { name: "PRO", features: [] } }] },
        domains: [
          { id: "domain-primary", domain: "www.example.com", isPrimary: true, createdAt: new Date("2026-01-01T00:00:00.000Z") },
          { id: "domain-old", domain: "old.example.com", isPrimary: false, createdAt: new Date("2026-01-02T00:00:00.000Z") },
        ],
      },
    });

    const result = await WebsiteHostResolverService.resolveHost("old.example.com");

    expect(result.routeKind).toBe("custom_domain");
    expect(result.redirectCode).toBe(308);
    expect(result.canonicalHost).toBe("www.example.com");
  });

  it("keeps verified domains beyond the downgraded plan limit stored but unroutable", async () => {
    tenantAccessMock.resolve.mockImplementation(async () =>
      defaultAccess({
        plan: { id: "plan-growth", name: "GROWTH", pricingId: "price-growth", features: [] },
      })
    );
    prismaMock.websiteDomain.findFirst.mockResolvedValue({
      id: "domain-extra",
      websiteId: "website-1",
      domain: "extra.example.com",
      status: "VERIFIED",
      isPrimary: false,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      website: {
        subdomain: "sparkle",
        status: "PUBLISHED",
        admin: {
          businessName: "Sparkle Cleaning",
          user: { status: "ACTIVE" },
          subscription: [{
            status: "ACTIVE",
            isTrial: false,
            currentPeriodEnd: new Date(Date.now() + 86_400_000),
            subscriptionPlan: { name: "GROWTH", features: [] },
          }],
        },
        domains: [
          { id: "domain-primary", domain: "www.example.com", isPrimary: true, createdAt: new Date("2026-01-01T00:00:00.000Z") },
          { id: "domain-extra", domain: "extra.example.com", isPrimary: false, createdAt: new Date("2026-01-02T00:00:00.000Z") },
        ],
      },
    });

    await expect(WebsiteHostResolverService.resolveHost("extra.example.com")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("fails closed for an unverified/unknown custom host", async () => {
    prismaMock.websiteDomain.findFirst.mockResolvedValue({
      websiteId: "website-1",
      domain: "unverified.example.com",
      status: "PENDING",
      isPrimary: false,
      website: { subdomain: "sparkle", status: "PUBLISHED", admin: { businessName: "Sparkle Cleaning", user: { status: "ACTIVE" }, subscription: [] }, domains: [] },
    });

    await expect(WebsiteHostResolverService.resolveHost("unverified.example.com")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("uses the verified primary custom domain as canonical even when traffic starts on the free subdomain", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-1",
      subdomain: "sparkle",
      status: "PUBLISHED",
      admin: { businessName: "Sparkle Cleaning", user: { status: "ACTIVE" }, subscription: [{ status: "ACTIVE", isTrial: false, currentPeriodEnd: new Date(Date.now() + 86_400_000), subscriptionPlan: { name: "GROWTH", features: [] } }] },
      domains: [{ domain: "www.example.com" }],
    });

    const result = await WebsiteHostResolverService.resolveHost("sparkle.sites.example.com");

    expect(result.redirectCode).toBe(308);
    expect(result.canonicalHost).toBe("www.example.com");
  });

  it("falls back to the free subdomain when no routing-ready primary custom domain is returned", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-1",
      subdomain: "bio-cleaning",
      status: "PUBLISHED",
      admin: { businessName: "Sparkle Cleaning", user: { status: "ACTIVE" }, subscription: [] },
      domains: [],
    });

    const result = await WebsiteHostResolverService.resolveHost("bio-cleaning.sites.example.com");

    expect(result.redirectCode).toBeNull();
    expect(result.canonicalHost).toBe("bio-cleaning.sites.example.com");
    expect(result.primaryCustomHost).toBeNull();
  });

  it("caches unknown wildcard hosts briefly so repeated probes do not hit Postgres", async () => {
    await expect(WebsiteHostResolverService.resolveHost("missing.sites.example.com")).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("current ~= ARGV[1]"),
      2,
      expect.stringContaining("website-host:missing.sites.example.com"),
      expect.stringContaining("site-route:v9:generation:"),
      "0",
      expect.stringContaining('"notFound":true'),
      "10",
    );
  });

  it("serves a cached host route without querying the database", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({
      version: 9,
      websiteId: "website-1",
      businessName: "Sparkle Cleaning",
      requestedSubdomain: "sparkle",
      canonicalSubdomain: "sparkle",
      isAlias: false,
      redirectCode: null,
      primaryCustomHost: null,
      availability: "live",
      requestedHost: "sparkle.sites.example.com",
      canonicalHost: "sparkle.sites.example.com",
      routeKind: "platform_subdomain",
      customDomain: null,
    }));

    const result = await WebsiteHostResolverService.resolveHost("sparkle.sites.example.com");
    expect(result.websiteId).toBe("website-1");
    expect(prismaMock.businessWebsite.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.websiteSubdomainAlias.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.websiteDomain.findFirst).not.toHaveBeenCalled();
  });

  it("never resolves a nested platform hostname as another tenant subdomain", async () => {
    prismaMock.websiteDomain.findFirst.mockResolvedValue(null);

    await expect(WebsiteHostResolverService.resolveHost("victim.attacker.sites.example.com")).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(prismaMock.businessWebsite.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { subdomain: "victim" } }),
    );
  });

  it("rejects URL-shaped and IP host input before any tenant database lookup", async () => {
    await expect(WebsiteHostResolverService.resolveHost("https://sparkle.sites.example.com/path")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(WebsiteHostResolverService.resolveHost("127.0.0.1")).rejects.toMatchObject({
      statusCode: 404,
    });

    expect(prismaMock.businessWebsite.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.websiteSubdomainAlias.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.websiteDomain.findFirst).not.toHaveBeenCalled();
  });

  it("keeps cached tenant routes isolated by exact host", async () => {
    redisMock.get.mockImplementation(async (key: string) => {
      if (key.includes("sparkle.sites.example.com")) {
        return JSON.stringify({
          version: 9,
          websiteId: "website-a",
          businessName: "Sparkle Cleaning",
          requestedSubdomain: "sparkle",
          canonicalSubdomain: "sparkle",
          isAlias: false,
          redirectCode: null,
          primaryCustomHost: null,
          availability: "live",
          requestedHost: "sparkle.sites.example.com",
          canonicalHost: "sparkle.sites.example.com",
          routeKind: "platform_subdomain",
          customDomain: null,
        });
      }
      return null;
    });
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-b",
      subdomain: "fresh",
      status: "PUBLISHED",
      admin: { businessName: "Sparkle Cleaning", user: { status: "ACTIVE" }, subscription: [] },
      domains: [],
    });

    const cached = await WebsiteHostResolverService.resolveHost("sparkle.sites.example.com");
    const fresh = await WebsiteHostResolverService.resolveHost("fresh.sites.example.com");

    expect(cached.websiteId).toBe("website-a");
    expect(fresh.websiteId).toBe("website-b");
    expect(fresh.canonicalHost).toBe("fresh.sites.example.com");
  });

  it("marks draft websites unpublished so the edge can fail closed before rendering", async () => {
    tenantAccessMock.resolve.mockResolvedValueOnce(
      defaultAccess({
        website: { status: "DRAFT", published: false, publicAccessAllowed: false, deniedReason: "WEBSITE_UNPUBLISHED" },
        access: {
          dashboardAllowed: true,
          publicWebsiteAllowed: false,
          publicWritesAllowed: false,
          backgroundJobsAllowed: true,
          recoveryAllowed: true,
          deniedReason: "WEBSITE_UNPUBLISHED",
        },
      })
    );
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-draft",
      subdomain: "draft-cleaner",
      status: "DRAFT",
      admin: { businessName: "Sparkle Cleaning", user: { status: "ACTIVE" }, subscription: [] },
      domains: [],
    });

    const result = await WebsiteHostResolverService.resolveHost("draft-cleaner.sites.example.com");
    expect(result.availability).toBe("unpublished");
  });

  it("marks suspended tenant accounts unavailable at the routing layer", async () => {
    tenantAccessMock.resolve.mockResolvedValueOnce(
      defaultAccess({
        access: {
          dashboardAllowed: false,
          publicWebsiteAllowed: false,
          publicWritesAllowed: false,
          backgroundJobsAllowed: false,
          recoveryAllowed: false,
          deniedReason: "TENANT_SUSPENDED",
        },
        website: { status: "PUBLISHED", published: true, publicAccessAllowed: false, deniedReason: "TENANT_SUSPENDED" },
      })
    );
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-suspended",
      subdomain: "paused-cleaner",
      status: "PUBLISHED",
      admin: { businessName: "Paused Cleaning", user: { status: "SUSPENDED" }, subscription: [] },
      domains: [],
    });

    const result = await WebsiteHostResolverService.resolveHost("paused-cleaner.sites.example.com");
    expect(result.availability).toBe("suspended");
    expect(result.businessName).toBe("Paused Cleaning");
  });

});
