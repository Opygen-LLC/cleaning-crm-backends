import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRequestUser } from "../../types/requestUser.interface";
import { UserRole } from "../../generated/prisma/enums";

const mocks = vi.hoisted(() => ({
  getAdminId: vi.fn(),
  profileFindUnique: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock("../../lib/utils/resolveAdminId", () => ({
  getAdminId: mocks.getAdminId,
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    adminProfile: { findUnique: mocks.profileFindUnique },
  },
}));

vi.mock("../../config/redis", () => ({
  default: { get: mocks.redisGet, set: mocks.redisSet },
}));

vi.mock("pdfkit", () => ({ default: vi.fn() }));

import { reportsService } from "./reports.service";

const user: IRequestUser = {
  id: "user-1",
  email: "admin@example.com",
  role: UserRole.ADMIN,
  adminId: "admin-1",
};

const cachedRevenue = {
  currency: "USD",
  stats: {
    totalRevenue: { value: 0, changePercent: 0 },
    totalProfit: { value: 0, changePercent: 0 },
    avgJobValue: { value: 0, changePercent: 0 },
    outstandingInvoices: { value: 0, changePercent: 0 },
  },
  chart: [],
  byService: [],
  recentTransactions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdminId.mockImplementation(async (requestUser: IRequestUser) => requestUser.adminId ?? "");
  mocks.profileFindUnique.mockResolvedValue({ currency: "USD" });
  mocks.redisGet.mockResolvedValue(JSON.stringify(cachedRevenue));
});

describe("reportsService authoritative tenant context", () => {
  it("resolves the tenant from the complete authenticated request user", async () => {
    const result = await reportsService.getRevenueReport(user, "30d");

    expect(result).toEqual(cachedRevenue);
    expect(mocks.getAdminId).toHaveBeenCalledTimes(1);
    expect(mocks.getAdminId).toHaveBeenCalledWith(user);
    expect(mocks.profileFindUnique).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      select: { currency: true },
    });
  });
  it("uses a tenant-specific cache namespace for a second admin", async () => {
    const userB: IRequestUser = { ...user, id: "user-2", email: "admin-b@example.com", adminId: "admin-2" };
    mocks.profileFindUnique.mockResolvedValueOnce({ currency: "USD" });
    mocks.redisGet.mockResolvedValueOnce(JSON.stringify(cachedRevenue));

    await reportsService.getRevenueReport(userB, "30d");

    expect(mocks.profileFindUnique).toHaveBeenCalledWith({
      where: { id: "admin-2" },
      select: { currency: true },
    });
    expect(mocks.redisGet).toHaveBeenCalledWith("reports:revenue:admin-2:30d");
  });

});
