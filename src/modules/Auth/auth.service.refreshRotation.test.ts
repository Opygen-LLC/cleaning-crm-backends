import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  txQueryRaw: vi.fn(),
  txExecuteRaw: vi.fn(),
  verifyToken: vi.fn(),
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
  invalidateRuntimeSessionValidities: vi.fn(),
  invalidateRuntimeAuth: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    session: { create: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    staffProfile: { findUnique: vi.fn() },
    account: { findFirst: vi.fn() },
  },
}));
vi.mock("../../lib/auth", () => ({ auth: { api: {} } }));
vi.mock("../../lib/utils/token", () => ({
  tokenUtils: {
    getAccessToken: mocks.getAccessToken,
    getRefreshToken: mocks.getRefreshToken,
  },
}));
vi.mock("../../lib/utils/jwt", () => ({ jwtUtils: { verifyToken: mocks.verifyToken } }));
vi.mock("../../config/ENV", () => ({ REFRESH_TOKEN_SECRET: "refresh-secret", REFRESH_TOKEN_REUSE_GRACE_MS: 8_000 }));
vi.mock("./accountProvisioning.service", () => ({ AccountProvisioningService: {} }));
vi.mock("./accountIntegrity.service", () => ({ AccountIntegrityService: {} }));
vi.mock("../../lib/utils/platformConfig", () => ({ getPlatformConfig: vi.fn() }));
vi.mock("../../lib/outbox/authEmailOutbox", () => ({ AuthEmailOutbox: {} }));
vi.mock("./sessionSecurity.service", () => ({
  bindRefreshCredentialToSession: vi.fn(),
  createRefreshFamilyId: vi.fn(() => "new-family"),
  hashRefreshCredential: vi.fn((value: string) => `hash:${value}`),
  revokeAllSessionsForUser: vi.fn(),
  revokeOtherSessionsForUser: vi.fn(),
  revokeSessionByToken: vi.fn(),
  revokeSessionByTokenWithOwner: vi.fn(),
}));
vi.mock("../../middlewares/privateResponseCache", () => ({ invalidatePrivateResponseCacheForUser: vi.fn() }));
vi.mock("../../lib/cache/authRuntimeCache", () => ({
  invalidateRuntimeAuth: mocks.invalidateRuntimeAuth,
  invalidateRuntimeSessionValidities: mocks.invalidateRuntimeSessionValidities,
  invalidateRuntimeSessionValidity: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({ default: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import authService from "./auth.service";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "session-1",
  token: "session-token",
  refreshTokenHash: "hash:refresh-old",
  previousRefreshTokenHash: null,
  refreshFamilyId: "family-1",
  refreshRotatedAt: new Date(),
  userId: "user-1",
  name: "Jamie Doe",
  email: "jamie@example.com",
  emailVerified: true,
  role: "ADMIN",
  status: "ACTIVE",
  staffStatus: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyToken.mockReturnValue({
    success: true,
    data: { userId: "user-1", role: "ADMIN", tokenType: "refresh", refreshFamilyId: "family-1" },
  });
  mocks.getAccessToken.mockReturnValue("access-new");
  mocks.getRefreshToken.mockReturnValue("refresh-new");
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({ $queryRaw: mocks.txQueryRaw, $executeRaw: mocks.txExecuteRaw }),
  );
  mocks.txExecuteRaw.mockResolvedValue(1);
});

describe("Phase 5 refresh credential rotation", () => {
  it("rotates a current credential and stores only the new hash", async () => {
    mocks.txQueryRaw.mockResolvedValueOnce([row()]);

    await expect(authService.getNewToken("refresh-old", "session-token")).resolves.toEqual({
      kind: "rotated",
      accessToken: "access-new",
      refreshToken: "refresh-new",
      sessionToken: "session-token",
    });
    expect(mocks.getRefreshToken).toHaveBeenCalledWith(expect.any(Object), "family-1");
    expect(mocks.txExecuteRaw).toHaveBeenCalledOnce();
    expect(mocks.invalidateRuntimeSessionValidities).not.toHaveBeenCalled();
  });

  it("allows a tiny previous-token grace window without overwriting the winning refresh cookie", async () => {
    mocks.txQueryRaw.mockResolvedValueOnce([
      row({
        refreshTokenHash: "hash:refresh-new",
        previousRefreshTokenHash: "hash:refresh-old",
        refreshRotatedAt: new Date(),
      }),
    ]);

    await expect(authService.getNewToken("refresh-old", "session-token")).resolves.toEqual({
      kind: "grace",
      accessToken: "access-new",
      refreshToken: null,
      sessionToken: "session-token",
    });
    expect(mocks.getRefreshToken).not.toHaveBeenCalled();
    expect(mocks.txExecuteRaw).toHaveBeenCalledOnce();
  });

  it("detects replay outside the grace window, revokes the family and emits a structured security event", async () => {
    mocks.txQueryRaw
      .mockResolvedValueOnce([
        row({
          refreshTokenHash: "hash:refresh-new",
          previousRefreshTokenHash: "hash:older-token",
          refreshRotatedAt: new Date(Date.now() - 60_000),
        }),
      ])
      .mockResolvedValueOnce([{ token: "session-token" }, { token: "family-session-2" }]);

    await expect(authService.getNewToken("stolen-old-refresh", "session-token")).rejects.toMatchObject({
      statusCode: 401,
      code: "REFRESH_TOKEN_REUSE_DETECTED",
      retryable: false,
    });
    expect(mocks.invalidateRuntimeSessionValidities).toHaveBeenCalledWith(["session-token", "family-session-2"]);
    expect(mocks.invalidateRuntimeAuth).toHaveBeenCalledWith("user-1");
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "auth_refresh_token_reuse", userId: "user-1", familyId: "family-1" }),
    );
  });
});
