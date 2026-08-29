import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("../../config/redis", () => ({
  default: { get: mocks.redisGet, set: mocks.redisSet },
}));
vi.mock("../../lib/prisma/prisma", () => ({
  prisma: { $queryRaw: mocks.queryRaw },
}));

import { WebsiteOverviewService } from "./websiteOverview.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSet.mockResolvedValue("OK");
});

describe("WebsiteOverviewService Phase 10 summary", () => {
  it("keeps rolling visitors/leads while exposing a calendar-month booking count", async () => {
    mocks.queryRaw.mockResolvedValue([{
      uniqueVisitors: 1240n,
      bookings: 41n,
      bookingsThisMonth: 34n,
      leads: 72n,
    }]);

    const result = await WebsiteOverviewService.getForAdminId("admin-1");

    expect(result).toEqual({
      days: 30,
      uniqueVisitors: 1240,
      bookings: 41,
      bookingsThisMonth: 34,
      leads: 72,
    });
    expect(mocks.redisSet).toHaveBeenCalledWith(
      expect.stringContaining("website-studio-overview:admin-1"),
      JSON.stringify(result),
      "EX",
      expect.any(Number),
    );
  });
});
