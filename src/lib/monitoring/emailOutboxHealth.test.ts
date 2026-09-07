import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  heartbeat: null as string | null,
  smtp: null as string | null,
  lastSuccess: null as string | null,
  pending: 0,
  retry: 0,
  dead: 0,
  oldest: null as { createdAt: Date } | null,
}));

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("../../config/ENV", () => ({
  OUTBOX_WORKER_POLL_MS: 1_000,
  OUTBOX_WORKER_REQUIRED: true,
  SMTP_EMAIL: "mailer@example.com",
  SMTP_HEALTHCHECK_INTERVAL_MS: 300_000,
  SMTP_HOST: "smtp.example.com",
  SMTP_PASSWORD: "app-password",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_VERIFY_ON_STARTUP: true,
}));

vi.mock("../../config/redis", () => ({
  default: {
    get: mocks.redisGet,
    set: mocks.redisSet,
  },
}));

vi.mock("../prisma/prisma", () => ({
  prisma: {
    outboxEvent: {
      count: mocks.count,
      findFirst: mocks.findFirst,
    },
  },
}));

import {
  EMAIL_OUTBOX_LAST_SUCCESS_KEY,
  EMAIL_OUTBOX_WORKER_HEARTBEAT_KEY,
  SMTP_TRANSPORT_HEALTH_KEY,
  getEmailOutboxHealth,
} from "./emailOutboxHealth";

beforeEach(() => {
  vi.clearAllMocks();
  state.heartbeat = JSON.stringify({
    at: new Date().toISOString(),
    pid: 42,
    processRole: "worker",
  });
  state.smtp = JSON.stringify({
    at: new Date().toISOString(),
    ok: true,
    error: null,
  });
  state.lastSuccess = null;
  state.pending = 0;
  state.retry = 0;
  state.dead = 0;
  state.oldest = null;

  mocks.redisGet.mockImplementation(async (key: string) => {
    if (key === EMAIL_OUTBOX_WORKER_HEARTBEAT_KEY) return state.heartbeat;
    if (key === SMTP_TRANSPORT_HEALTH_KEY) return state.smtp;
    if (key === EMAIL_OUTBOX_LAST_SUCCESS_KEY) return state.lastSuccess;
    return null;
  });
  mocks.count.mockImplementation(async ({ where }: { where: { status?: unknown } }) => {
    if (where.status === "RETRY") return state.retry;
    if (where.status === "DEAD") return state.dead;
    return state.pending;
  });
  mocks.findFirst.mockImplementation(async () => state.oldest);
});

describe("email outbox production health", () => {
  it("is healthy only when the dedicated worker heartbeat and SMTP transport check are fresh", async () => {
    const health = await getEmailOutboxHealth();

    expect(health.healthy).toBe(true);
    expect(health.worker).toMatchObject({ required: true, alive: true });
    expect(health.smtp.connectivity.healthy).toBe(true);
  });

  it("detects a worker that is not running even when the queue is empty", async () => {
    state.heartbeat = null;

    const health = await getEmailOutboxHealth();

    expect(health.healthy).toBe(false);
    expect(health.worker.alive).toBe(false);
    expect(health.queue.pendingCount).toBe(0);
  });

  it("reports SMTP authentication/connectivity verification failure as degraded", async () => {
    state.smtp = JSON.stringify({
      at: new Date().toISOString(),
      ok: false,
      error: "SMTP authentication failed",
    });

    const health = await getEmailOutboxHealth();

    expect(health.healthy).toBe(false);
    expect(health.smtp.connectivity).toMatchObject({
      healthy: false,
      error: "SMTP authentication failed",
    });
  });

  it("keeps a dead-lettered verification event visible as an unhealthy condition", async () => {
    state.dead = 1;

    const health = await getEmailOutboxHealth();

    expect(health.healthy).toBe(false);
    expect(health.queue.deadLetterCount).toBe(1);
  });
});
