import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, prismaMock, publicCacheRevalidationMock } = vi.hoisted(() => ({
  redisMock: { get: vi.fn(), set: vi.fn(), eval: vi.fn(), del: vi.fn() },
  prismaMock: { businessWebsite: { findUnique: vi.fn() } },
  publicCacheRevalidationMock: {
    triggerWithFallback: vi.fn(async () => ({ configured: true, delivered: true, queued: false })),
  },
}));

vi.mock("../../config/redis", () => ({ default: redisMock }));
vi.mock("../../config/ENV", () => ({
  WEBSITE_PROJECTION_CACHE_TTL_SECONDS: 180,
  WEBSITE_PROJECTION_CACHE_JITTER_RATIO: 0,
  WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS: 8,
  WEBSITE_PROJECTION_STALE_TTL_SECONDS: 900,
  WEBSITE_PROJECTION_WAIT_FOR_FILL_MS: 100,
}));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/outbox/publicWebsiteCacheOutbox", () => ({
  PublicWebsiteCacheRevalidation: publicCacheRevalidationMock,
}));

import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";

const envelope = (data: unknown) => JSON.stringify({
  version: 10,
  websiteId: "website-1",
  generation: 0,
  cachedAt: new Date().toISOString(),
  data,
});

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.eval.mockResolvedValue(1);
});

describe("Phase 23 public website projection cache", () => {
  it("serves a fresh Redis projection without touching the loader", async () => {
    redisMock.get.mockResolvedValueOnce(envelope({ business: { name: "Bio Cleaning" } }));
    const loader = vi.fn();

    await expect(WebsiteProjectionCacheService.getOrLoad("website-1", loader))
      .resolves.toEqual({ business: { name: "Bio Cleaning" } });
    expect(loader).not.toHaveBeenCalled();
  });

  it("serves stale-on-expiry when another process owns the rebuild lock", async () => {
    redisMock.get
      .mockResolvedValueOnce(null) // fresh
      .mockResolvedValueOnce(envelope({ services: ["cached"] })); // stale
    redisMock.set.mockResolvedValueOnce(null); // another process has NX lock
    const loader = vi.fn();

    await expect(WebsiteProjectionCacheService.getOrLoad("website-1", loader))
      .resolves.toEqual({ services: ["cached"] });
    expect(loader).not.toHaveBeenCalled();
  });

  it("writes fresh and stale copies atomically against the observed generation", async () => {
    redisMock.get
      .mockResolvedValueOnce(null) // initial fresh miss
      .mockResolvedValueOnce(null) // recheck after lock
      .mockResolvedValueOnce("0"); // generation
    const loader = vi.fn().mockResolvedValue({ services: ["current"] });

    await WebsiteProjectionCacheService.getOrLoad("website-1", loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SET', KEYS[2]"),
      3,
      "website-projection:website-1",
      "site-projection-stale:v10:website-1",
      "site-projection-generation:v10:website-1",
      "0",
      expect.stringContaining('"version":10'),
      "180000",
      "900000",
    );
  });

  it("invalidates fresh, stale and rebuild lock in the same generation bump", async () => {
    await WebsiteProjectionCacheService.invalidateWebsite("website-1");
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("INCR"),
      4,
      "website-projection:website-1",
      "site-projection-stale:v10:website-1",
      "site-projection-lock:v10:website-1",
      "site-projection-generation:v10:website-1",
    );
    expect(publicCacheRevalidationMock.triggerWithFallback).toHaveBeenCalledWith({
      websiteId: "website-1",
      tenantIdentifier: undefined,
      tenantIdentifiers: undefined,
      reason: "website-projection-invalidated",
    });
  });

  it("can defer Next revalidation so Publish can invalidate routing before the direct callback", async () => {
    await WebsiteProjectionCacheService.invalidateWebsite("website-1", "admin-1", { revalidateNext: false });
    expect(redisMock.eval).toHaveBeenCalled();
    expect(publicCacheRevalidationMock.triggerWithFallback).not.toHaveBeenCalled();
  });

  it("uses the cached admin→website mapping so CRM invalidation does not query Postgres", async () => {
    redisMock.get.mockResolvedValueOnce("website-1");
    await WebsiteProjectionCacheService.invalidateAdminWebsite("admin-1");
    expect(prismaMock.businessWebsite.findUnique).not.toHaveBeenCalled();
  });
});
