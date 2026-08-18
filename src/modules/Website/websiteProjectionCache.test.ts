import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, prismaMock, publicCacheOutboxMock } = vi.hoisted(() => ({
  redisMock: { get: vi.fn(), set: vi.fn(), eval: vi.fn() },
  prismaMock: { businessWebsite: { findUnique: vi.fn() } },
  publicCacheOutboxMock: { enqueue: vi.fn(async () => true) },
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
vi.mock("../../lib/outbox/publicWebsiteCacheOutbox", () => ({ PublicWebsiteCacheOutbox: publicCacheOutboxMock }));

import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";

const envelope = (data: unknown) => JSON.stringify({
  version: 9,
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
      "site-projection-stale:v9:website-1",
      "site-projection-generation:v9:website-1",
      "0",
      expect.stringContaining('"version":9'),
      "180",
      "900",
    );
  });

  it("invalidates fresh, stale and rebuild lock in the same generation bump", async () => {
    await WebsiteProjectionCacheService.invalidateWebsite("website-1");
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("INCR"),
      4,
      "website-projection:website-1",
      "site-projection-stale:v9:website-1",
      "site-projection-lock:v9:website-1",
      "site-projection-generation:v9:website-1",
    );
    expect(publicCacheOutboxMock.enqueue).toHaveBeenCalledWith({ websiteId: "website-1" });
  });

  it("uses the cached admin→website mapping so CRM invalidation does not query Postgres", async () => {
    redisMock.get.mockResolvedValueOnce("website-1");
    await WebsiteProjectionCacheService.invalidateAdminWebsite("admin-1");
    expect(prismaMock.businessWebsite.findUnique).not.toHaveBeenCalled();
  });
});
