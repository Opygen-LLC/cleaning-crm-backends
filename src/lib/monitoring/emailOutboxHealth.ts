import {
  OUTBOX_WORKER_ENABLED,
  OUTBOX_WORKER_POLL_MS,
  SMTP_EMAIL,
  SMTP_HOST,
  SMTP_PASSWORD,
  SMTP_PORT,
  SMTP_SECURE,
} from "../../config/ENV";
import redis from "../../config/redis";
import { AUTH_EMAIL_OUTBOX_TOPIC } from "../outbox/authEmailOutbox";
import { prisma } from "../prisma/prisma";

export const EMAIL_OUTBOX_WORKER_HEARTBEAT_KEY =
  "ops:email-outbox-worker:heartbeat:v1";
export const EMAIL_OUTBOX_LAST_SUCCESS_KEY =
  "ops:email-outbox-worker:last-success:v1";

const heartbeatTtlSeconds = Math.max(
  30,
  Math.ceil((OUTBOX_WORKER_POLL_MS * 6) / 1000),
);
const heartbeatFreshnessMs = heartbeatTtlSeconds * 1000;

interface WorkerHeartbeat {
  at: string;
  pid: number;
  processRole: "worker";
}

export async function recordEmailOutboxWorkerHeartbeat(): Promise<void> {
  const payload: WorkerHeartbeat = {
    at: new Date().toISOString(),
    pid: process.pid,
    processRole: "worker",
  };

  await redis.set(
    EMAIL_OUTBOX_WORKER_HEARTBEAT_KEY,
    JSON.stringify(payload),
    "EX",
    heartbeatTtlSeconds,
  );
}

export async function recordEmailOutboxSuccessfulDelivery(): Promise<void> {
  // This is intentionally a simple timestamp rather than event payload data: the
  // monitoring surface must never expose recipient addresses or OTP contents.
  await redis.set(EMAIL_OUTBOX_LAST_SUCCESS_KEY, new Date().toISOString());
}

const readHeartbeat = async (): Promise<WorkerHeartbeat | null> => {
  const raw = await redis.get(EMAIL_OUTBOX_WORKER_HEARTBEAT_KEY).catch(() => null);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<WorkerHeartbeat>;
    if (
      typeof parsed.at !== "string" ||
      typeof parsed.pid !== "number" ||
      parsed.processRole !== "worker"
    ) {
      return null;
    }
    return parsed as WorkerHeartbeat;
  } catch {
    return null;
  }
};

const smtpConfiguration = () => {
  const port = Number(SMTP_PORT);
  const missing: string[] = [];
  if (!SMTP_HOST?.trim()) missing.push("SMTP_HOST");
  if (!SMTP_EMAIL?.trim()) missing.push("SMTP_EMAIL");
  if (!SMTP_PASSWORD?.trim()) missing.push("SMTP_PASSWORD");
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    missing.push("SMTP_PORT");
  }

  const configuredSecure = SMTP_SECURE !== undefined ? SMTP_SECURE === "true" : port === 465;
  const effectiveSecure = port === 465 ? true : port === 587 ? false : configuredSecure;
  const warnings: string[] = [];
  if (SMTP_SECURE !== undefined && configuredSecure !== effectiveSecure) {
    warnings.push(`SMTP_SECURE=${SMTP_SECURE} is normalized to ${String(effectiveSecure)} for port ${port}.`);
  }

  return {
    configured: missing.length === 0,
    missing,
    warnings,
    host: SMTP_HOST?.trim() || null,
    port: Number.isInteger(port) && port > 0 ? port : null,
    secure: effectiveSecure,
  };
};

export async function getEmailOutboxHealth() {
  const topic = AUTH_EMAIL_OUTBOX_TOPIC.EMAIL_VERIFICATION_REQUESTED;

  const [
    pendingCount,
    retryCount,
    deadLetterCount,
    oldestPending,
    lastSuccessfulDeliveryAt,
    heartbeat,
  ] = await Promise.all([
    prisma.outboxEvent.count({
      where: {
        topic,
        processedAt: null,
        status: { in: ["PENDING", "RETRY", "PROCESSING"] },
      },
    }),
    prisma.outboxEvent.count({ where: { topic, status: "RETRY" } }),
    prisma.outboxEvent.count({ where: { topic, status: "DEAD" } }),
    prisma.outboxEvent.findFirst({
      where: {
        topic,
        processedAt: null,
        status: { in: ["PENDING", "RETRY", "PROCESSING"] },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    redis.get(EMAIL_OUTBOX_LAST_SUCCESS_KEY).catch(() => null),
    readHeartbeat(),
  ]);

  const smtp = smtpConfiguration();
  const heartbeatAt = heartbeat?.at ? new Date(heartbeat.at) : null;
  const heartbeatAgeMs =
    heartbeatAt && Number.isFinite(heartbeatAt.getTime())
      ? Math.max(0, Date.now() - heartbeatAt.getTime())
      : null;
  const workerAlive =
    OUTBOX_WORKER_ENABLED &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs <= heartbeatFreshnessMs;

  const oldestPendingAgeMs = oldestPending
    ? Math.max(0, Date.now() - oldestPending.createdAt.getTime())
    : null;

  const healthy = smtp.configured && workerAlive && deadLetterCount === 0;

  return {
    healthy,
    status: healthy ? "ok" : "degraded",
    smtp,
    worker: {
      enabled: OUTBOX_WORKER_ENABLED,
      alive: workerAlive,
      heartbeatAt: heartbeat?.at ?? null,
      heartbeatAgeMs,
      pollIntervalMs: OUTBOX_WORKER_POLL_MS,
    },
    queue: {
      pendingCount,
      oldestPendingAt: oldestPending?.createdAt.toISOString() ?? null,
      oldestPendingAgeMs,
      retryCount,
      deadLetterCount,
      lastSuccessfulDeliveryAt,
    },
  };
}
