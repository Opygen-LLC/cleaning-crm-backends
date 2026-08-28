import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  userFindUnique: vi.fn(),
  staffFindUnique: vi.fn(),
  sessionFindFirst: vi.fn(),
  sessionDeleteMany: vi.fn(),
  sessionUpdate: vi.fn(),
  executeRaw: vi.fn(),
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
  verifyToken: vi.fn(),
  signOut: vi.fn(),
  provisionRegisteredAdmin: vi.fn(),
  getPlatformConfig: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    $executeRaw: mocks.executeRaw,
    user: { findUnique: mocks.userFindUnique },
    staffProfile: { findUnique: mocks.staffFindUnique },
    session: {
      findFirst: mocks.sessionFindFirst,
      deleteMany: mocks.sessionDeleteMany,
      update: mocks.sessionUpdate,
      create: vi.fn(),
    },
    account: { findFirst: vi.fn() },
  },
}));
vi.mock("../../lib/auth", () => ({ auth: { api: { signInEmail: mocks.signInEmail, signOut: mocks.signOut } } }));
vi.mock("../../lib/utils/token", () => ({ tokenUtils: { getAccessToken: mocks.getAccessToken, getRefreshToken: mocks.getRefreshToken } }));
vi.mock("../../lib/utils/jwt", () => ({ jwtUtils: { verifyToken: mocks.verifyToken } }));
vi.mock("../../config/ENV", () => ({ REFRESH_TOKEN_SECRET: "test-refresh-secret" }));
vi.mock("./accountProvisioning.service", () => ({ AccountProvisioningService: { provisionRegisteredAdmin: mocks.provisionRegisteredAdmin } }));
vi.mock("./accountIntegrity.service", () => ({ AccountIntegrityService: { assertAdminReadyForActivation: vi.fn() } }));
vi.mock("../../lib/utils/platformConfig", () => ({ getPlatformConfig: mocks.getPlatformConfig }));
vi.mock("../../lib/outbox/authEmailOutbox", () => ({ AuthEmailOutbox: { enqueueEmailVerification: vi.fn() } }));

import authService from "./auth.service";

const signedInAdmin = {
  id: "user-1",
  name: "Jamie Doe",
  email: "jamie@example.com",
  emailVerified: true,
  role: "ADMIN",
  status: "ACTIVE",
  needPasswordChange: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signInEmail.mockResolvedValue({ user: { ...signedInAdmin }, token: "session-token", redirect: false });
  mocks.staffFindUnique.mockResolvedValue(null);
  mocks.sessionDeleteMany.mockResolvedValue({ count: 0 });
  mocks.executeRaw.mockResolvedValue(0);
  mocks.getAccessToken.mockReturnValue("access-token");
  mocks.getRefreshToken.mockReturnValue("refresh-token");
  mocks.verifyToken.mockReturnValue({ success: true, data: { userId: "user-1", role: "ADMIN" } });
  mocks.sessionFindFirst.mockResolvedValue({
    id: "session-1",
    token: "session-token",
    user: { ...signedInAdmin, staff: null },
  });
  mocks.sessionUpdate.mockResolvedValue({ token: "session-token" });
  mocks.signOut.mockResolvedValue({ success: true });
  mocks.getPlatformConfig.mockResolvedValue({ registrationOpen: true, defaultTrialDays: 14 });
  mocks.provisionRegisteredAdmin.mockResolvedValue({ userId: "user-1", reservedSubdomain: "jamie-cleaning" });
});

describe("login optimized deterministic session contract", () => {
  it("uses Better Auth identity directly and performs one session-cap cleanup statement", async () => {
    const result = await authService.login({ email: "JAMIE@example.com", password: "correct-password" });
    expect(mocks.signInEmail).toHaveBeenCalledWith({ body: { email: "jamie@example.com", password: "correct-password" } });
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.staffFindUnique).not.toHaveBeenCalled();
    expect(mocks.executeRaw).toHaveBeenCalledOnce();
    expect(result).toEqual({
      user: { id: "user-1", name: "Jamie Doe", email: "jamie@example.com", role: "ADMIN", status: "ACTIVE" },
      sessionToken: "session-token",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
  });

  it("fails instead of returning a partial 200 when Better Auth omits the session token", async () => {
    mocks.signInEmail.mockResolvedValue({ user: { ...signedInAdmin }, redirect: false });
    await expect(authService.login({ email: "jamie@example.com", password: "correct-password" })).rejects.toMatchObject({
      statusCode: 500,
      code: "AUTH_SESSION_NOT_CREATED",
      retryable: true,
    });
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("revokes a newly-created Better Auth session when the account is suspended", async () => {
    mocks.signInEmail.mockResolvedValue({ user: { ...signedInAdmin, status: "SUSPENDED" }, token: "session-token", redirect: false });
    await expect(authService.login({ email: "jamie@example.com", password: "correct-password" })).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCOUNT_SUSPENDED",
    });
    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({ where: { token: "session-token" } });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it("loads only the staff activation state for STAFF logins", async () => {
    mocks.signInEmail.mockResolvedValue({ user: { ...signedInAdmin, role: "STAFF" }, token: "session-token", redirect: false });
    mocks.staffFindUnique.mockResolvedValue({ status: "ACTIVE" });
    const result = await authService.login({ email: "jamie@example.com", password: "correct-password" });
    expect(mocks.staffFindUnique).toHaveBeenCalledWith({ where: { userId: "user-1" }, select: { status: true } });
    expect(result.user.role).toBe("STAFF");
  });
});

describe("refresh optimized session contract", () => {
  it("loads the session and current database account state in one read", async () => {
    const result = await authService.getNewToken("refresh-token-old", "session-token");
    expect(mocks.sessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { token: "session-token", userId: "user-1", expiresAt: { gt: expect.any(Date) } },
      select: expect.objectContaining({ id: true, token: true, user: expect.any(Object) }),
    }));
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(result).toEqual({ accessToken: "access-token", refreshToken: "refresh-token", sessionToken: "session-token" });
  });

  it("does not refresh a revoked or expired Better Auth session", async () => {
    mocks.sessionFindFirst.mockResolvedValue(null);
    await expect(authService.getNewToken("refresh-token-old", "session-token")).rejects.toMatchObject({
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

  it("does not return onboarding/password routing authority from login", async () => {
    const result = await authService.login({ email: "jamie@example.com", password: "correct-password" });
    expect(result).not.toHaveProperty("isOnboardingComplete");
    expect(result).not.toHaveProperty("needPasswordChange");
  });

  it("me remains the full profile endpoint while /auth/session stays lightweight", async () => {
    mocks.userFindUnique.mockResolvedValue({ ...signedInAdmin, admin: null, staff: null });
    const result = await authService.me({ id: "user-1", email: "jamie@example.com", role: "ADMIN" } as never);
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: "user-1" }, include: { admin: true, staff: true } });
    expect(result.id).toBe("user-1");
  });

  it("logout revokes the Better Auth session and remains idempotent", async () => {
    await expect(authService.logout("session-token")).resolves.toEqual({ success: true });
    expect(mocks.signOut).toHaveBeenCalledOnce();
    mocks.signOut.mockClear();
    await expect(authService.logout()).resolves.toEqual({ success: true });
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
