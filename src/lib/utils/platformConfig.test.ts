import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("../prisma/prisma", () => ({
  prisma: {
    superAdminConfig: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.upsert.mockResolvedValue({ key: "platformConfig" });
});

describe("platformConfig email verification policy", () => {
  it("fails closed to OTP required when no platform config row exists", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const { getPlatformConfig } = await import("./platformConfig");

    const config = await getPlatformConfig();

    expect(config.authentication.requireEmailOtpVerification).toBe(true);
  });

  it("fails closed when a legacy config has no authentication setting", async () => {
    mocks.findUnique.mockResolvedValue({
      key: "platformConfig",
      value: JSON.stringify({ registrationOpen: true, authentication: {} }),
    });
    const { getPlatformConfig } = await import("./platformConfig");

    const config = await getPlatformConfig();

    expect(config.authentication.requireEmailOtpVerification).toBe(true);
  });

  it("honors only an explicit persisted false value to disable registration OTP", async () => {
    mocks.findUnique.mockResolvedValue({
      key: "platformConfig",
      value: JSON.stringify({ authentication: { requireEmailOtpVerification: false } }),
    });
    const { getPlatformConfig } = await import("./platformConfig");

    const config = await getPlatformConfig();

    expect(config.authentication.requireEmailOtpVerification).toBe(false);
  });

  it("keeps the authentication policy when an unrelated platform setting is updated", async () => {
    mocks.findUnique.mockResolvedValue({
      key: "platformConfig",
      value: JSON.stringify({ authentication: { requireEmailOtpVerification: false } }),
    });
    const { updatePlatformConfig } = await import("./platformConfig");

    const updated = await updatePlatformConfig({ defaultTrialDays: 21 });

    expect(updated.authentication.requireEmailOtpVerification).toBe(false);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        value: expect.stringContaining('"requireEmailOtpVerification":false'),
      }),
    }));
  });
});
