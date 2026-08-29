import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRequestUser } from "../../types/requestUser.interface";
import { UserRole } from "../../generated/prisma/enums";

const mocks = vi.hoisted(() => ({
  getAdminId: vi.fn(),
  preferenceFindUnique: vi.fn(),
  preferenceCreate: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationUpdateMany: vi.fn(),
  redisGet: vi.fn(),
  redisSetex: vi.fn(),
  redisDel: vi.fn(),
}));

vi.mock("../../lib/utils/resolveAdminId", () => ({
  getAdminId: mocks.getAdminId,
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    notificationPreference: {
      findUnique: mocks.preferenceFindUnique,
      create: mocks.preferenceCreate,
      upsert: vi.fn(),
    },
    notificationTemplate: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    notification: {
      findMany: mocks.notificationFindMany,
      updateMany: mocks.notificationUpdateMany,
    },
  },
}));

vi.mock("../../config/redis", () => ({
  default: {
    get: mocks.redisGet,
    setex: mocks.redisSetex,
    del: mocks.redisDel,
  },
}));

vi.mock("../../lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { notificationService } from "./notification.service";

const user: IRequestUser = {
  id: "user-1",
  email: "admin@example.com",
  role: UserRole.ADMIN,
  adminId: "admin-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdminId.mockResolvedValue("admin-1");
  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSetex.mockResolvedValue("OK");
  mocks.redisDel.mockResolvedValue(1);
  mocks.notificationFindMany.mockResolvedValue([]);
  mocks.notificationUpdateMany.mockResolvedValue({ count: 1 });
  mocks.preferenceFindUnique.mockResolvedValue({ id: "prefs-1", adminId: "admin-1" });
});

describe("notificationService authoritative tenant context", () => {
  it("passes the full authenticated request user to the shared resolver", async () => {
    await notificationService.getInbox(user);
    await notificationService.markRead(user, "notification-1");
    await notificationService.markAllRead(user);
    await notificationService.getNotificationPrefs(user);

    expect(mocks.getAdminId).toHaveBeenCalledTimes(4);
    for (const call of mocks.getAdminId.mock.calls) {
      expect(call[0]).toBe(user);
    }
  });

  it("scopes notification reads and writes to the resolved admin id", async () => {
    await notificationService.getInbox(user);
    await notificationService.markRead(user, "notification-1");
    await notificationService.markAllRead(user);

    expect(mocks.notificationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { adminId: "admin-1" } }),
    );
    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
      where: { id: "notification-1", adminId: "admin-1" },
      data: { isRead: true },
    });
    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
      where: { adminId: "admin-1", isRead: false },
      data: { isRead: true },
    });
  });
});
