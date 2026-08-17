import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, prismaMock } = vi.hoisted(() => ({
  redisMock: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  prismaMock: { businessWebsite: { findUnique: vi.fn() } },
}));

vi.mock("../../config/redis", () => ({ default: redisMock }));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));

import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.del.mockResolvedValue(1);
});

describe("public website projection cache", () => {
  it("fails open to a cache miss when Redis is unavailable", async () => {
    redisMock.get.mockRejectedValue(new Error("redis down"));
    await expect(WebsiteProjectionCacheService.get("website-1")).resolves.toBeNull();
  });

  it("invalidates the tenant website cache after CRM mutations", async () => {
    prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1" });
    await WebsiteProjectionCacheService.invalidateAdminWebsite("admin-1");
    expect(redisMock.del).toHaveBeenCalledWith("site-projection:v3:website-1");
  });
});
