import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userUpdate: vi.fn(),
  assertVerificationCandidate: vi.fn(),
  verifyEmailOTP: vi.fn(),
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
  sessionCreate: vi.fn(),
  bindRefreshCredentialToSession: vi.fn(),
  createRefreshFamilyId: vi.fn(),
  invalidateRuntimeAuth: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    user: { update: mocks.userUpdate },
    session: { create: mocks.sessionCreate },
  },
}));
vi.mock("../../lib/auth", () => ({ auth: { api: { verifyEmailOTP: mocks.verifyEmailOTP } } }));
vi.mock("../../lib/utils/token", () => ({ tokenUtils: { getAccessToken: mocks.getAccessToken, getRefreshToken: mocks.getRefreshToken } }));
vi.mock("../../lib/utils/jwt", () => ({ jwtUtils: {} }));
vi.mock("../../config/ENV", () => ({ REFRESH_TOKEN_SECRET: "test-refresh-secret", REFRESH_TOKEN_REUSE_GRACE_MS: 8_000, NODE_ENV: "test" }));
vi.mock("./accountProvisioning.service", () => ({ AccountProvisioningService: { provisionRegisteredAdmin: vi.fn() } }));
vi.mock("./accountIntegrity.service", () => ({ AccountIntegrityService: { assertEmailVerificationCandidate: mocks.assertVerificationCandidate } }));
vi.mock("../../lib/utils/platformConfig", () => ({ getPlatformConfig: vi.fn() }));
vi.mock("../../lib/outbox/authEmailOutbox", () => ({ AuthEmailOutbox: { enqueueEmailVerification: vi.fn() } }));
vi.mock("./sessionSecurity.service", () => ({
  bindRefreshCredentialToSession: mocks.bindRefreshCredentialToSession,
  createRefreshFamilyId: mocks.createRefreshFamilyId,
  hashRefreshCredential: vi.fn((value: string) => `hash:${value}`),
  revokeAllSessionsForUser: vi.fn(),
  revokeOtherSessionsForUser: vi.fn(),
  revokeSessionByToken: vi.fn(),
}));
vi.mock("../../lib/cache/authRuntimeCache", () => ({
  invalidateRuntimeAuth: mocks.invalidateRuntimeAuth,
  invalidateRuntimeSessionValidities: vi.fn(),
  invalidateRuntimeSessionValidity: vi.fn(),
}));

import authService from "./auth.service";

const verifiedAdmin = {
  id: "user-1",
  role: "ADMIN",
  name: "Jamie",
  email: "jamie@example.com",
  emailVerified: true,
  status: "PENDING",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertVerificationCandidate.mockResolvedValue({ id: "user-1", role: "ADMIN", hasCredentialAccount: true });
  mocks.verifyEmailOTP.mockResolvedValue({ user: { ...verifiedAdmin }, token: "better-auth-token" });
  mocks.userUpdate.mockResolvedValue({ id: "user-1", name: "Jamie", email: "jamie@example.com", emailVerified: true, role: "ADMIN" });
  mocks.getAccessToken.mockReturnValue("access-token");
  mocks.getRefreshToken.mockReturnValue("refresh-token");
  mocks.sessionCreate.mockResolvedValue({ token: "fallback-session-token" });
  mocks.createRefreshFamilyId.mockReturnValue("family-verify");
  mocks.bindRefreshCredentialToSession.mockResolvedValue({ bound: true, revokedTokens: [] });
});

describe("verifyEmail optimized ADMIN activation", () => {
  it("resolves identity + credential ownership in one application query before consuming OTP", async () => {
    const result = await authService.verifyEmail("jamie@example.com", "123456");
    expect(mocks.assertVerificationCandidate).toHaveBeenCalledWith("jamie@example.com");
    expect(mocks.assertVerificationCandidate.mock.invocationCallOrder[0]).toBeLessThan(mocks.verifyEmailOTP.mock.invocationCallOrder[0]!);
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { status: "ACTIVE" },
      select: { id: true, name: true, email: true, emailVerified: true, role: true },
    });
    expect(result).toMatchObject({ accessToken: "access-token", refreshToken: "refresh-token", token: "better-auth-token" });
    expect(mocks.bindRefreshCredentialToSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", sessionToken: "better-auth-token", refreshToken: "refresh-token", refreshFamilyId: "family-verify", maxSessions: 3,
    }));
    expect(mocks.sessionCreate).not.toHaveBeenCalled();
  });

  it("rejects social-only accounts before consuming the OTP", async () => {
    mocks.assertVerificationCandidate.mockRejectedValue(Object.assign(new Error("Email verification is not allowed for social login accounts."), { statusCode: 400 }));
    await expect(authService.verifyEmail("jamie@example.com", "123456")).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.verifyEmailOTP).not.toHaveBeenCalled();
  });

  it("does not consume the OTP when tenant provisioning is incomplete", async () => {
    mocks.assertVerificationCandidate.mockRejectedValue(Object.assign(new Error("Website provisioning is not complete yet."), { statusCode: 409, code: "WEBSITE_PROVISIONING_INCOMPLETE" }));
    await expect(authService.verifyEmail("jamie@example.com", "123456")).rejects.toMatchObject({ statusCode: 409, code: "WEBSITE_PROVISIONING_INCOMPLETE" });
    expect(mocks.verifyEmailOTP).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it("creates a server-side fallback session when Better Auth omits the auto-sign-in token", async () => {
    mocks.verifyEmailOTP.mockResolvedValue({ user: { ...verifiedAdmin } });
    const result = await authService.verifyEmail("jamie@example.com", "123456");
    expect(mocks.sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user-1", token: expect.any(String), expiresAt: expect.any(Date) }),
      select: { token: true },
    });
    expect(result.token).toBe("fallback-session-token");
  });

  it("returns AUTH_VERIFICATION_SESSION_FAILED when a fallback session cannot be persisted", async () => {
    mocks.verifyEmailOTP.mockResolvedValue({ user: { ...verifiedAdmin } });
    mocks.sessionCreate.mockRejectedValue(new Error("database unavailable"));
    await expect(authService.verifyEmail("jamie@example.com", "123456")).rejects.toMatchObject({
      statusCode: 500,
      code: "AUTH_VERIFICATION_SESSION_FAILED",
      retryable: true,
    });
  });
});
