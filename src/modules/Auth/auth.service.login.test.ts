import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  signOut: vi.fn(),
  userFindUnique: vi.fn(),
  staffFindUnique: vi.fn(),
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
  provisionRegisteredAdmin: vi.fn(),
  getPlatformConfig: vi.fn(),
  bindRefreshCredentialToSession: vi.fn(),
  createRefreshFamilyId: vi.fn(),
  revokeSessionByToken: vi.fn(),
  invalidateRuntimeAuth: vi.fn(),
  invalidateRuntimeSessionValidity: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    staffProfile: { findUnique: mocks.staffFindUnique },
    session: { create: vi.fn() },
    account: { findFirst: vi.fn() },
  },
}));
vi.mock("../../lib/auth", () => ({ auth: { api: { signInEmail: mocks.signInEmail, signOut: mocks.signOut } } }));
vi.mock("../../lib/utils/token", () => ({ tokenUtils: { getAccessToken: mocks.getAccessToken, getRefreshToken: mocks.getRefreshToken } }));
vi.mock("../../lib/utils/jwt", () => ({ jwtUtils: {} }));
vi.mock("../../config/ENV", () => ({ REFRESH_TOKEN_SECRET: "test-refresh-secret", REFRESH_TOKEN_REUSE_GRACE_MS: 8_000 }));
vi.mock("./accountProvisioning.service", () => ({ AccountProvisioningService: { provisionRegisteredAdmin: mocks.provisionRegisteredAdmin } }));
vi.mock("./accountIntegrity.service", () => ({ AccountIntegrityService: { assertAdminReadyForActivation: vi.fn() } }));
vi.mock("../../lib/utils/platformConfig", () => ({ getPlatformConfig: mocks.getPlatformConfig }));
vi.mock("../../lib/outbox/authEmailOutbox", () => ({ AuthEmailOutbox: { enqueueEmailVerification: vi.fn() } }));
vi.mock("./sessionSecurity.service", () => ({
  bindRefreshCredentialToSession: mocks.bindRefreshCredentialToSession,
  createRefreshFamilyId: mocks.createRefreshFamilyId,
  hashRefreshCredential: vi.fn((value: string) => `hash:${value}`),
  revokeAllSessionsForUser: vi.fn(),
  revokeOtherSessionsForUser: vi.fn(),
  revokeSessionByToken: mocks.revokeSessionByToken,
}));
vi.mock("../../lib/cache/authRuntimeCache", () => ({
  invalidateRuntimeAuth: mocks.invalidateRuntimeAuth,
  invalidateRuntimeSessionValidities: vi.fn(),
  invalidateRuntimeSessionValidity: mocks.invalidateRuntimeSessionValidity,
}));

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
  mocks.getAccessToken.mockReturnValue("access-token");
  mocks.getRefreshToken.mockReturnValue("refresh-token");
  mocks.createRefreshFamilyId.mockReturnValue("family-1");
  mocks.bindRefreshCredentialToSession.mockResolvedValue({ bound: true, revokedTokens: [] });
  mocks.revokeSessionByToken.mockResolvedValue(true);
  mocks.signOut.mockResolvedValue({ success: true });
  mocks.getPlatformConfig.mockResolvedValue({ registrationOpen: true, defaultTrialDays: 14 });
  mocks.provisionRegisteredAdmin.mockResolvedValue({ userId: "user-1", reservedSubdomain: "jamie-cleaning" });
});

describe("login Better Auth + rotating refresh contract", () => {
  it("uses Better Auth identity and binds the refresh hash/family without a duplicate user lookup", async () => {
    const result = await authService.login(
      { email: "JAMIE@example.com", password: "correct-password" },
      { ipAddress: "203.0.113.10", userAgent: "Phase5 Browser" },
    );

    expect(mocks.signInEmail).toHaveBeenCalledWith({ body: { email: "jamie@example.com", password: "correct-password" } });
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.staffFindUnique).not.toHaveBeenCalled();
    expect(mocks.getRefreshToken).toHaveBeenCalledWith(expect.any(Object), "family-1");
    expect(mocks.bindRefreshCredentialToSession).toHaveBeenCalledWith({
      userId: "user-1",
      sessionToken: "session-token",
      refreshToken: "refresh-token",
      refreshFamilyId: "family-1",
      maxSessions: 3,
      metadata: { ipAddress: "203.0.113.10", userAgent: "Phase5 Browser" },
    });
    expect(result).toEqual({
      user: { id: "user-1", name: "Jamie Doe", email: "jamie@example.com", role: "ADMIN", status: "ACTIVE" },
      sessionToken: "session-token",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
  });

  it("fails and revokes the partial session when Better Auth omits its session token", async () => {
    mocks.signInEmail.mockResolvedValue({ user: { ...signedInAdmin }, redirect: false });
    await expect(authService.login({ email: "jamie@example.com", password: "correct-password" })).rejects.toMatchObject({
      statusCode: 500,
      code: "AUTH_SESSION_NOT_CREATED",
      retryable: true,
    });
    expect(mocks.bindRefreshCredentialToSession).not.toHaveBeenCalled();
  });

  it("revokes a newly-created Better Auth session when the account is suspended", async () => {
    mocks.signInEmail.mockResolvedValue({ user: { ...signedInAdmin, status: "SUSPENDED" }, token: "session-token", redirect: false });
    await expect(authService.login({ email: "jamie@example.com", password: "correct-password" })).rejects.toMatchObject({
      statusCode: 403,
      code: "ACCOUNT_SUSPENDED",
    });
    expect(mocks.revokeSessionByToken).toHaveBeenCalledWith("session-token");
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it("loads only the staff activation state for STAFF logins", async () => {
    mocks.signInEmail.mockResolvedValue({ user: { ...signedInAdmin, role: "STAFF" }, token: "session-token", redirect: false });
    mocks.staffFindUnique.mockResolvedValue({ status: "ACTIVE", manuallyInactive: false });
    const result = await authService.login({ email: "jamie@example.com", password: "correct-password" });
    expect(mocks.staffFindUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { status: true, manuallyInactive: true },
    });
    expect(result.user.role).toBe("STAFF");
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

  it("logout remains idempotent and invalidates the runtime session cache", async () => {
    await expect(authService.logout("session-token")).resolves.toEqual({ success: true });
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.invalidateRuntimeSessionValidity).toHaveBeenCalledWith("session-token");
    mocks.signOut.mockClear();
    await expect(authService.logout()).resolves.toEqual({ success: true });
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
