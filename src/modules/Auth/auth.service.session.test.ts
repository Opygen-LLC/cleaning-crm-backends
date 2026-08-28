import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    session: { deleteMany: vi.fn() },
  },
}));
vi.mock("../../lib/auth", () => ({ auth: { api: {} } }));
vi.mock("../../lib/utils/token", () => ({ tokenUtils: {} }));
vi.mock("../../lib/utils/jwt", () => ({ jwtUtils: {} }));
vi.mock("../../config/ENV", () => ({ REFRESH_TOKEN_SECRET: "test-refresh-secret", REFRESH_TOKEN_REUSE_GRACE_MS: 8_000 }));
vi.mock("./accountProvisioning.service", () => ({ AccountProvisioningService: {} }));
vi.mock("./accountIntegrity.service", () => ({ AccountIntegrityService: {} }));
vi.mock("../../lib/utils/platformConfig", () => ({ getPlatformConfig: vi.fn() }));
vi.mock("../../lib/outbox/authEmailOutbox", () => ({ AuthEmailOutbox: {} }));
vi.mock("./sessionSecurity.service", () => ({ bindRefreshCredentialToSession: vi.fn(), createRefreshFamilyId: vi.fn(), hashRefreshCredential: vi.fn(), revokeAllSessionsForUser: vi.fn(), revokeOtherSessionsForUser: vi.fn(), revokeSessionByToken: vi.fn() }));
vi.mock("../../lib/cache/authRuntimeCache", () => ({ invalidateRuntimeAuth: vi.fn(), invalidateRuntimeSessionValidities: vi.fn(), invalidateRuntimeSessionValidity: vi.fn() }));

import authService from "./auth.service";

const requestUser = { id: "user-1", email: "jamie@example.com", role: "ADMIN" } as never;

const snapshot = {
  expiresAt: new Date("2026-10-01T00:00:00.000Z"),
  id: "user-1",
  name: "Jamie Doe",
  email: "jamie@example.com",
  emailVerified: true,
  role: "ADMIN",
  status: "ACTIVE",
  needPasswordChange: false,
  staffStatus: null,
  onboardingCompletedAt: null,
  onboardingCompletedSteps: ["business_profile", "branding"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ ...snapshot }]);
});

describe("canonical auth session snapshot", () => {
  it("returns the first incomplete onboarding key from exactly one SQL lookup", async () => {
    const result = await authService.session(requestUser, "session-token");
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      authenticated: true,
      user: { id: "user-1", role: "ADMIN", status: "ACTIVE", emailVerified: true },
      onboarding: { completed: false, currentStep: "services" },
      needPasswordChange: false,
      session: { expiresAt: expect.any(Date) },
    });
  });

  it("returns completed onboarding after launch", async () => {
    mocks.queryRaw.mockResolvedValue([{ ...snapshot, onboardingCompletedAt: new Date("2026-08-28T00:00:00.000Z"), onboardingCompletedSteps: [] }]);
    await expect(authService.session(requestUser, "session-token")).resolves.toMatchObject({
      onboarding: { completed: true, currentStep: null },
    });
  });

  it("rejects a missing or revoked Better Auth session as INVALID_SESSION", async () => {
    await expect(authService.session(requestUser, undefined)).rejects.toMatchObject({ statusCode: 401, code: "INVALID_SESSION" });
    mocks.queryRaw.mockResolvedValue([]);
    await expect(authService.session(requestUser, "revoked-token")).rejects.toMatchObject({ statusCode: 401, code: "INVALID_SESSION" });
  });
});
