import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  userFindUnique: vi.fn(),
  sessionFindUnique: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionCount: vi.fn(),
  sessionFindMany: vi.fn(),
  sessionDeleteMany: vi.fn(),
  sessionUpdate: vi.fn(),
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
  verifyToken: vi.fn(),
  signOut: vi.fn(),
  provisionRegisteredAdmin: vi.fn(),
  getPlatformConfig: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    session: {
      findUnique: mocks.sessionFindUnique,
      findFirst: mocks.sessionFindFirst,
      count: mocks.sessionCount,
      findMany: mocks.sessionFindMany,
      deleteMany: mocks.sessionDeleteMany,
      update: mocks.sessionUpdate,
      create: vi.fn(),
    },
    account: { findFirst: vi.fn() },
  },
}));

vi.mock("../../lib/auth", () => ({
  auth: {
    api: {
      signInEmail: mocks.signInEmail,
      signOut: mocks.signOut,
    },
  },
}));

vi.mock("../../lib/utils/token", () => ({
  tokenUtils: {
    getAccessToken: mocks.getAccessToken,
    getRefreshToken: mocks.getRefreshToken,
  },
}));

vi.mock("../../lib/utils/jwt", () => ({
  jwtUtils: { verifyToken: mocks.verifyToken },
}));

vi.mock("../../config/ENV", () => ({
  REFRESH_TOKEN_SECRET: "test-refresh-secret",
}));

vi.mock("./accountProvisioning.service", () => ({
  AccountProvisioningService: { provisionRegisteredAdmin: mocks.provisionRegisteredAdmin },
}));
vi.mock("./accountIntegrity.service", () => ({
  AccountIntegrityService: { assertAdminReadyForActivation: vi.fn() },
}));
vi.mock("../../lib/utils/platformConfig", () => ({ getPlatformConfig: mocks.getPlatformConfig }));
vi.mock("../../lib/outbox/authEmailOutbox", () => ({
  AuthEmailOutbox: { enqueueEmailVerification: vi.fn() },
}));

import authService from "./auth.service";

const activeAdmin = {
  id: "user-1",
  name: "Jamie Doe",
  email: "jamie@example.com",
  emailVerified: true,
  role: "ADMIN",
  status: "ACTIVE",
  needPasswordChange: false,
  staff: null,
  admin: { onboardingCompletedAt: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signInEmail.mockResolvedValue({
    user: {
      id: "user-1",
      name: "Jamie Doe",
      email: "jamie@example.com",
      emailVerified: true,
      role: "ADMIN",
    },
    token: "session-token",
    redirect: false,
  });
  mocks.userFindUnique.mockResolvedValue(activeAdmin);
  mocks.sessionFindUnique.mockResolvedValue({
    id: "session-1",
    userId: "user-1",
    expiresAt: new Date(Date.now() + 60_000),
  });
  mocks.sessionCount.mockResolvedValue(1);
  mocks.sessionFindMany.mockResolvedValue([]);
  mocks.sessionDeleteMany.mockResolvedValue({ count: 0 });
  mocks.getAccessToken.mockReturnValue("access-token");
  mocks.getRefreshToken.mockReturnValue("refresh-token");
  mocks.verifyToken.mockReturnValue({
    success: true,
    data: { userId: "user-1", role: "ADMIN" },
  });
  mocks.sessionFindFirst.mockResolvedValue({ id: "session-1", token: "session-token" });
  mocks.sessionUpdate.mockResolvedValue({ token: "session-token" });
  mocks.signOut.mockResolvedValue({ success: true });
  mocks.getPlatformConfig.mockResolvedValue({ registrationOpen: true, defaultTrialDays: 14 });
  mocks.provisionRegisteredAdmin.mockResolvedValue({ userId: "user-1", reservedSubdomain: "jamie-cleaning" });
});

describe("login deterministic session contract", () => {
  it("returns only the application login state plus server credentials", async () => {
    const result = await authService.login({
      email: "JAMIE@example.com",
      password: "correct-password",
    });

    expect(mocks.signInEmail).toHaveBeenCalledWith({
      body: { email: "jamie@example.com", password: "correct-password" },
    });
    expect(result).toEqual({
      user: {
        id: "user-1",
        name: "Jamie Doe",
        email: "jamie@example.com",
        role: "ADMIN",
        status: "ACTIVE",
      },
      sessionToken: "session-token",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
  });

  it("fails instead of returning a partial 200 when Better Auth omits the session token", async () => {
    mocks.signInEmail.mockResolvedValue({
      user: { id: "user-1", emailVerified: true },
      redirect: false,
    });

    await expect(
      authService.login({ email: "jamie@example.com", password: "correct-password" }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: "AUTH_SESSION_NOT_CREATED",
      retryable: true,
    });

    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });

  it("revokes the provisional session when application account reconciliation fails", async () => {
    mocks.userFindUnique.mockRejectedValue(new Error("database unavailable"));

    await expect(
      authService.login({ email: "jamie@example.com", password: "correct-password" }),
    ).rejects.toThrow("database unavailable");

    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({
      where: { token: "session-token" },
    });
  });

  it("revokes a newly-created Better Auth session when the account is suspended", async () => {
    mocks.userFindUnique.mockResolvedValue({
      ...activeAdmin,
      status: "SUSPENDED",
    });

    await expect(
      authService.login({ email: "jamie@example.com", password: "correct-password" }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCOUNT_SUSPENDED",
    });

    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({
      where: { token: "session-token" },
    });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it("keeps the current session and removes only the oldest excess sessions", async () => {
    mocks.sessionCount.mockResolvedValue(4);
    mocks.sessionFindMany.mockResolvedValue([{ id: "oldest-session" }]);

    await authService.login({ email: "jamie@example.com", password: "correct-password" });

    expect(mocks.sessionFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        token: { not: "session-token" },
        expiresAt: { gt: expect.any(Date) },
      },
      orderBy: { createdAt: "asc" },
      take: 1,
      select: { id: true },
    });
    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["oldest-session"] } },
    });
  });
});

describe("refresh deterministic session contract", () => {
  it("reissues tokens from current database account state", async () => {
    const result = await authService.getNewToken("refresh-token-old", "session-token");

    expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
      where: {
        token: "session-token",
        userId: "user-1",
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true, token: true },
    });
    expect(mocks.getAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", role: "ADMIN", email: "jamie@example.com" }),
    );
    expect(result).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      sessionToken: "session-token",
      role: "ADMIN",
    });
  });

  it("does not refresh a revoked or expired Better Auth session", async () => {
    mocks.sessionFindFirst.mockResolvedValue(null);

    await expect(
      authService.getNewToken("refresh-token-old", "session-token"),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "REFRESH_SESSION_EXPIRED",
      retryable: false,
    });
  });
});


describe("complete auth lifecycle service regression", () => {
  it("register delegates to the canonical provisioning transaction", async () => {
    const result = await authService.register({ businessName: "Jamie Cleaning", name: "Jamie Doe", email: "jamie@example.com", password: "correct-password" });
    expect(mocks.provisionRegisteredAdmin).toHaveBeenCalledWith({ businessName: "Jamie Cleaning", name: "Jamie Doe", email: "jamie@example.com", password: "correct-password", trialDays: 14, mobileNumber: undefined, businessType: undefined, licenseNumber: undefined });
    expect(result).toEqual({ userId: "user-1", reservedSubdomain: "jamie-cleaning" });
  });
  it("does not return onboarding state from login; canonical /auth/session owns routing", async () => {
    mocks.userFindUnique.mockResolvedValue({ ...activeAdmin, admin: { onboardingCompletedAt: new Date() } });
    const result = await authService.login({ email: "jamie@example.com", password: "correct-password" });
    expect(result).not.toHaveProperty("isOnboardingComplete");
    expect(result).not.toHaveProperty("needPasswordChange");
  });
  it("returns STAFF identity for token creation without exposing password-routing state", async () => {
    mocks.userFindUnique.mockResolvedValue({ ...activeAdmin, role: "STAFF", needPasswordChange: true, staff: { status: "ACTIVE" }, admin: null });
    const result = await authService.login({ email: "jamie@example.com", password: "correct-password" });
    expect(result.user.role).toBe("STAFF");
    expect(result).not.toHaveProperty("needPasswordChange");
  });
  it("me reads current database account state", async () => {
    mocks.userFindUnique.mockResolvedValue({ ...activeAdmin, emailVerified: true });
    const result = await authService.me({ id: "user-1", email: "jamie@example.com", role: "ADMIN" } as never);
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: "user-1" }, include: { admin: true, staff: true } }); expect(result.id).toBe("user-1");
  });
  it("logout revokes the Better Auth session and remains idempotent", async () => {
    await expect(authService.logout("session-token")).resolves.toEqual({ success: true }); expect(mocks.signOut).toHaveBeenCalledOnce(); const headers=mocks.signOut.mock.calls[0][0].headers as Headers; expect(headers.get("Authorization")).toBe("Bearer session-token"); mocks.signOut.mockClear(); await expect(authService.logout()).resolves.toEqual({ success: true }); expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
