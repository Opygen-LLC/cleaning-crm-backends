import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, prismaMock } = vi.hoisted(() => ({
  redisMock: { get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn() },
  prismaMock: { businessWebsite: { findUnique: vi.fn() } },
}));

vi.mock("../../config/redis", () => ({ default: redisMock }));
vi.mock("../../config/ENV", () => ({
  WEBSITE_PROJECTION_CACHE_TTL_SECONDS: 180,
  WEBSITE_PROJECTION_CACHE_JITTER_RATIO: 0,
  WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS: 8,
}));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));

import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockImplementation(async (...args: unknown[]) => args.includes("NX") ? "OK" : "OK");
  redisMock.del.mockResolvedValue(1);
  redisMock.eval.mockResolvedValue(1);
});

describe("public website projection cache", () => {
  it("fails open to a cache miss when Redis is unavailable", async () => {
    redisMock.get.mockRejectedValue(new Error("redis down"));
    await expect(WebsiteProjectionCacheService.get("website-1")).resolves.toBeNull();
  });

  it("invalidates both the projection and rebuild lock after CRM mutations", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1" });
    await WebsiteProjectionCacheService.invalidateAdminWebsite("admin-1");
    expect(redisMock.del).toHaveBeenCalledWith(
      "site-projection:v4:website-1",
      "site-projection-lock:v4:website-1",
    );
  });

  it("returns a valid Redis projection without calling the loader", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({
      version: 4,
      websiteId: "website-1",
      cachedAt: new Date().toISOString(),
      data: { business: { name: "Sparkle" } },
    }));
    const loader = vi.fn();

    const result = await WebsiteProjectionCacheService.getOrLoad("website-1", loader);

    expect(result).toEqual({ business: { name: "Sparkle" } });
    expect(loader).not.toHaveBeenCalled();
  });

  it("rebuilds a cold projection once after acquiring the distributed lock", async () => {
    const loader = vi.fn().mockResolvedValue({ business: { name: "Sparkle" } });

    const result = await WebsiteProjectionCacheService.getOrLoad("website-1", loader);

    expect(result).toEqual({ business: { name: "Sparkle" } });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redisMock.set).toHaveBeenCalledWith(
      "site-projection-lock:v4:website-1",
      expect.any(String),
      "EX",
      8,
      "NX",
    );
    expect(redisMock.set).toHaveBeenCalledWith(
      "site-projection:v4:website-1",
      expect.stringContaining('"version":4'),
      "EX",
      180,
    );
  });
});
