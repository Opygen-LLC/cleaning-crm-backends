import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  accountFindFirst: vi.fn(),
  adminFindUnique: vi.fn(),
  verifyEmailOTP: vi.fn(),
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
    },
    account: { findFirst: mocks.accountFindFirst },
    adminProfile: { findUnique: mocks.adminFindUnique },
  },
}));

vi.mock("../../lib/auth", () => ({
  auth: {
    api: {
      verifyEmailOTP: mocks.verifyEmailOTP,
    },
  },
}));

vi.mock("../../lib/utils/token", () => ({
  tokenUtils: {
    getAccessToken: mocks.getAccessToken,
    getRefreshToken: mocks.getRefreshToken,
  },
}));

vi.mock("../../lib/utils/jwt", () => ({ jwtUtils: {} }));
vi.mock("../../config/ENV", () => ({ REFRESH_TOKEN_SECRET: "test-refresh-secret" }));
vi.mock("./accountProvisioning.service", () => ({
  AccountProvisioningService: { provisionRegisteredAdmin: vi.fn() },
}));
vi.mock("../../lib/utils/platformConfig", () => ({ getPlatformConfig: vi.fn() }));
vi.mock("../../lib/outbox/authEmailOutbox", () => ({
  AuthEmailOutbox: { enqueueEmailVerification: vi.fn() },
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
  mocks.userFindUnique.mockResolvedValue({ id: "user-1", role: "ADMIN" });
  mocks.accountFindFirst.mockResolvedValue({ userId: "user-1" });
  mocks.adminFindUnique.mockResolvedValue({
    onboardingCompletedAt: null,
    businessWebsite: { id: "website-1" },
    subscription: [{ id: "trial-1" }],
  });
  mocks.verifyEmailOTP.mockResolvedValue({ user: { ...verifiedAdmin } });
  mocks.userUpdate.mockResolvedValue({ ...verifiedAdmin, status: "ACTIVE" });
  mocks.getAccessToken.mockReturnValue("access-token");
  mocks.getRefreshToken.mockReturnValue("refresh-token");
});

describe("verifyEmail deterministic ADMIN activation", () => {
  it("checks profile + active trial/subscription + website before consuming the OTP", async () => {
    const result = await authService.verifyEmail("jamie@example.com", "123456");

    expect(mocks.adminFindUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: {
        onboardingCompletedAt: true,
        businessWebsite: { select: { id: true } },
        subscription: {
          where: { status: "ACTIVE" },
          select: { id: true },
          take: 1,
        },
      },
    });
    expect(mocks.adminFindUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.verifyEmailOTP.mock.invocationCallOrder[0]!,
    );
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { email: "jamie@example.com" },
      data: { status: "ACTIVE" },
    });
    expect(result).toMatchObject({
      isOnboardingComplete: false,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user: { status: "ACTIVE" },
    });
  });

  it("does not consume the OTP or activate the user when website provisioning is incomplete", async () => {
    mocks.adminFindUnique.mockResolvedValue({
      onboardingCompletedAt: null,
      businessWebsite: null,
      subscription: [{ id: "trial-1" }],
    });

    await expect(
      authService.verifyEmail("jamie@example.com", "123456"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "WEBSITE_PROVISIONING_INCOMPLETE",
    });

    expect(mocks.verifyEmailOTP).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it("does not consume the OTP or activate the user when trial/subscription provisioning is incomplete", async () => {
    mocks.adminFindUnique.mockResolvedValue({
      onboardingCompletedAt: null,
      businessWebsite: { id: "website-1" },
      subscription: [],
    });

    await expect(
      authService.verifyEmail("jamie@example.com", "123456"),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "SUBSCRIPTION_PROVISIONING_INCOMPLETE",
    });

    expect(mocks.verifyEmailOTP).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
