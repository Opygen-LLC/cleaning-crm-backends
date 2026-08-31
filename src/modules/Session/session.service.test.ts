import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revokeSessionByIdForUser: vi.fn(),
  revokeOtherSessionsForUser: vi.fn(),
  queryRaw: vi.fn(),
  invalidateRuntimeAuth: vi.fn(),
  invalidatePrivateResponseCacheForUser: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: { $queryRaw: mocks.queryRaw },
}));

vi.mock("../Auth/sessionSecurity.service", () => ({
  revokeSessionByIdForUser: mocks.revokeSessionByIdForUser,
  revokeOtherSessionsForUser: mocks.revokeOtherSessionsForUser,
}));

vi.mock("../../lib/cache/authRuntimeCache", () => ({
  invalidateRuntimeAuth: mocks.invalidateRuntimeAuth,
}));

vi.mock("../../middlewares/privateResponseCache", () => ({
  invalidatePrivateResponseCacheForUser: mocks.invalidatePrivateResponseCacheForUser,
}));

import { sessionService } from "./session.service";

const user = { id: "user-1", email: "jamie@example.com", role: "ADMIN" } as never;

describe("session service revoke contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an idempotent success shape for an already-revoked or expired session", async () => {
    mocks.revokeSessionByIdForUser.mockResolvedValue({ found: false, revokedCurrent: false });

    await expect(
      sessionService.deleteMySession(user, "session-1", "current-token"),
    ).resolves.toEqual({
      id: "session-1",
      revoked: false,
      alreadyRevoked: true,
      revokedCurrent: false,
    });
  });

  it("reports whether the revoked row was the current browser session", async () => {
    mocks.revokeSessionByIdForUser.mockResolvedValue({ found: true, revokedCurrent: true });

    await expect(
      sessionService.deleteMySession(user, "session-1", "current-token"),
    ).resolves.toEqual({
      id: "session-1",
      revoked: true,
      alreadyRevoked: false,
      revokedCurrent: true,
    });
    expect(mocks.invalidateRuntimeAuth).toHaveBeenCalledWith("user-1");
    expect(mocks.invalidatePrivateResponseCacheForUser).toHaveBeenCalledWith("user-1");
  });
});
