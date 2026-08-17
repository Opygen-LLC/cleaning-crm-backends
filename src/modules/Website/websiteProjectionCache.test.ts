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

  it("atomically bumps the generation and invalidates projection/lock after CRM mutations", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1" });
    await WebsiteProjectionCacheService.invalidateAdminWebsite("admin-1");
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("INCR"),
      3,
      "site-projection:v6:website-1",
      "site-projection-lock:v6:website-1",
      "site-projection-generation:v6:website-1",
    );
  });

  it("returns a valid Redis projection without calling the loader", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({
      version: 6,
      websiteId: "website-1",
      generation: 3,
      cachedAt: new Date().toISOString(),
      data: { business: { name: "Sparkle" } },
    }));
    const loader = vi.fn();

    const result = await WebsiteProjectionCacheService.getOrLoad("website-1", loader);

    expect(result).toEqual({ business: { name: "Sparkle" } });
    expect(loader).not.toHaveBeenCalled();
  });

  it("rebuilds a cold projection under the distributed lock", async () => {
    redisMock.get.mockResolvedValue(null);
    const loader = vi.fn().mockResolvedValue({ business: { name: "Sparkle" } });

    const result = await WebsiteProjectionCacheService.getOrLoad("website-1", loader);

    expect(result).toEqual({ business: { name: "Sparkle" } });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redisMock.set).toHaveBeenCalledWith(
      "site-projection-lock:v6:website-1",
      expect.any(String),
      "EX",
      8,
      "NX",
    );
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("current ~= ARGV[1]"),
      2,
      "site-projection:v6:website-1",
      "site-projection-generation:v6:website-1",
      "0",
      expect.stringContaining('"version":5'),
      "180",
    );
  });

  it("reloads when a CRM mutation changes generation during a cold projection build", async () => {
    // First cache lookup miss, first generation=4. After first load the CAS
    // fails (mutation raced), then the new generation=5 is read and reloaded.
    redisMock.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("4")
      .mockResolvedValueOnce("5");
    redisMock.eval
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    const loader = vi.fn()
      .mockResolvedValueOnce({ services: ["old"] })
      .mockResolvedValueOnce({ services: ["new"] });

    const result = await WebsiteProjectionCacheService.getOrLoad("website-1", loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ services: ["new"] });
  });
});
