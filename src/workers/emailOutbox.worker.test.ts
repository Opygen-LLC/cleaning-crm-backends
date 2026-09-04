import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  outboxUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  sendVerificationOTP: vi.fn(),
  successfulDelivery: vi.fn(),
  heartbeat: vi.fn(),
}));

vi.mock("../config/ENV", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/ENV")>();
  return {
    ...actual,
    NEXT_REVALIDATE_SECRET: "test-secret",
    NEXT_REVALIDATE_TIMEOUT_MS: 1000,
    NEXT_REVALIDATE_URL: "https://frontend.invalid/revalidate",
    NODE_ENV: "test",
    OUTBOX_LOCK_TIMEOUT_MS: 30_000,
    OUTBOX_WORKER_BATCH_SIZE: 10,
    OUTBOX_WORKER_ENABLED: false,
    OUTBOX_WORKER_POLL_MS: 1_000,
  };
});
vi.mock("../lib/prisma/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    user: { findUnique: mocks.userFindUnique },
    outboxEvent: { update: mocks.outboxUpdate },
    notificationDelivery: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("../lib/auth", () => ({ auth: { api: { sendVerificationOTP: mocks.sendVerificationOTP } } }));
vi.mock("../lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("../lib/monitoring/emailOutboxHealth", () => ({
  recordEmailOutboxSuccessfulDelivery: mocks.successfulDelivery,
  recordEmailOutboxWorkerHeartbeat: mocks.heartbeat,
}));
vi.mock("../lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { processEmailOutboxOnce } from "./emailOutbox.worker";

const event = (attempts: number, maxAttempts = 3) => ({
  id: `event-${attempts}`,
  topic: "AUTH_EMAIL_VERIFICATION_REQUESTED",
  payload: { userId: "user-1", email: "owner@example.com" },
  attempts,
  maxAttempts,
});

describe("email outbox worker durable verification delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindUnique.mockResolvedValue({ email: "owner@example.com", emailVerified: false });
    mocks.successfulDelivery.mockResolvedValue(undefined);
    mocks.outboxUpdate.mockResolvedValue({});
  });

  it("delivers OTP through Better Auth and marks the outbox processed", async () => {
    mocks.queryRaw.mockResolvedValue([event(1)]);
    mocks.sendVerificationOTP.mockResolvedValue({ status: true });

    await expect(processEmailOutboxOnce()).resolves.toEqual({ claimed: 1 });
    expect(mocks.sendVerificationOTP).toHaveBeenCalledWith({
      body: { email: "owner@example.com", type: "email-verification" },
    });
    expect(mocks.outboxUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "event-1" },
      data: expect.objectContaining({ status: "PROCESSED" }),
    }));
  });

  it("moves a transient SMTP/OTP failure to RETRY without consuming the event", async () => {
    mocks.queryRaw.mockResolvedValue([event(1, 3)]);
    mocks.sendVerificationOTP.mockRejectedValue(new Error("SMTP unavailable"));

    await expect(processEmailOutboxOnce()).resolves.toEqual({ claimed: 1 });
    expect(mocks.outboxUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "event-1" },
      data: expect.objectContaining({ status: "RETRY" }),
    }));
  });

  it("moves an exhausted delivery to DEAD for operational alerting", async () => {
    mocks.queryRaw.mockResolvedValue([event(3, 3)]);
    mocks.sendVerificationOTP.mockRejectedValue(new Error("SMTP unavailable"));

    await expect(processEmailOutboxOnce()).resolves.toEqual({ claimed: 1 });
    expect(mocks.outboxUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "event-3" },
      data: expect.objectContaining({ status: "DEAD" }),
    }));
  });
});
