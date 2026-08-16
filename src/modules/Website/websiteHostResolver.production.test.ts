import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, prismaMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  prismaMock: {
    businessWebsite: { findUnique: vi.fn() },
    websiteSubdomainAlias: { findUnique: vi.fn() },
    websiteDomain: { findUnique: vi.fn() },
  },
}));

vi.mock("../../config/redis", () => ({ default: redisMock }));
vi.mock("../../config/ENV", () => ({ WEBSITE_BASE_DOMAIN: "sites.example.com" }));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));

import { WebsiteHostResolverService } from "./websiteHostResolver.service";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.del.mockResolvedValue(1);
  prismaMock.businessWebsite.findUnique.mockResolvedValue(null);
  prismaMock.websiteSubdomainAlias.findUnique.mockResolvedValue(null);
  prismaMock.websiteDomain.findUnique.mockResolvedValue(null);
});

describe("production tenant host routing", () => {
  it("routes the canonical free subdomain without a redirect", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-1",
      subdomain: "sparkle",
      domains: [],
    });

    const result = await WebsiteHostResolverService.resolveHost("sparkle.sites.example.com");

    expect(result.routeKind).toBe("platform_subdomain");
    expect(result.canonicalSubdomain).toBe("sparkle");
    expect(result.canonicalHost).toBe("sparkle.sites.example.com");
    expect(result.redirectCode).toBeNull();
  });

  it("turns an old subdomain alias into one permanent redirect to the current host", async () => {
    prismaMock.websiteSubdomainAlias.findUnique.mockResolvedValue({
      websiteId: "website-1",
      website: {
        subdomain: "sparkle-london",
        domains: [],
      },
    });

    const result = await WebsiteHostResolverService.resolveHost("sparkle.sites.example.com");

    expect(result.routeKind).toBe("subdomain_alias");
    expect(result.redirectCode).toBe(308);
    expect(result.canonicalHost).toBe("sparkle-london.sites.example.com");
  });

  it("redirects a non-primary verified custom domain to the selected canonical custom host", async () => {
    prismaMock.websiteDomain.findUnique.mockResolvedValue({
      websiteId: "website-1",
      domain: "old.example.com",
      status: "VERIFIED",
      isPrimary: false,
      website: {
        subdomain: "sparkle",
        domains: [{ domain: "www.example.com" }],
      },
    });

    const result = await WebsiteHostResolverService.resolveHost("old.example.com");

    expect(result.routeKind).toBe("custom_domain");
    expect(result.redirectCode).toBe(308);
    expect(result.canonicalHost).toBe("www.example.com");
  });

  it("fails closed for an unverified/unknown custom host", async () => {
    prismaMock.websiteDomain.findUnique.mockResolvedValue({
      websiteId: "website-1",
      domain: "unverified.example.com",
      status: "PENDING",
      isPrimary: false,
      website: { subdomain: "sparkle", domains: [] },
    });

    await expect(WebsiteHostResolverService.resolveHost("unverified.example.com")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("uses the verified primary custom domain as canonical even when traffic starts on the free subdomain", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-1",
      subdomain: "sparkle",
      domains: [{ domain: "www.example.com" }],
    });

    const result = await WebsiteHostResolverService.resolveHost("sparkle.sites.example.com");

    expect(result.redirectCode).toBe(308);
    expect(result.canonicalHost).toBe("www.example.com");
  });
});
