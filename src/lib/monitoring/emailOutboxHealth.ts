import {
  OUTBOX_WORKER_POLL_MS,
  OUTBOX_WORKER_REQUIRED,
  SMTP_EMAIL,
  SMTP_HEALTHCHECK_INTERVAL_MS,
  SMTP_HOST,
  SMTP_PASSWORD,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_VERIFY_ON_STARTUP,
} from "../../config/ENV";
import redis from "../../config/redis";
import { AUTH_EMAIL_OUTBOX_TOPIC } from "../outbox/authEmailOutbox";
import { prisma } from "../prisma/prisma";

export const EMAIL_OUTBOX_WORKER_HEARTBEAT_KEY =
  "ops:email-outbox-worker:heartbeat:v1";
export const EMAIL_OUTBOX_LAST_SUCCESS_KEY =
  "ops:email-outbox-worker:last-success:v1";
export const SMTP_TRANSPORT_HEALTH_KEY =
  "ops:smtp-transport:health:v1";

const heartbeatTtlSeconds = Math.max(
  30,
  Math.ceil((OUTBOX_WORKER_POLL_MS * 6) / 1000),
);
const heartbeatFreshnessMs = heartbeatTtlSeconds * 1000;
const smtpHealthTtlSeconds = Math.max(
  180,
  Math.ceil((SMTP_HEALTHCHECK_INTERVAL_MS * 3) / 1000),
);
const smtpHealthFreshnessMs = smtpHealthTtlSeconds * 1000;

interface WorkerHeartbeat {
  at: string;
  pid: number;
  processRole: "worker";
}

interface SmtpTransportHealth {
  at: string;
  ok: boolean;
  error: string | null;
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

export async function recordSmtpTransportHealth(
  ok: boolean,
  error?: string | null,
): Promise<void> {
  const payload: SmtpTransportHealth = {
    at: new Date().toISOString(),
    ok,
    // Store only the already-sanitized transport error from verifyEmailTransport.
    // Never persist credentials, recipients, or message bodies in the health key.
    error: ok ? null : String(error || "SMTP transport verification failed").slice(0, 500),
  };
  await redis.set(
    SMTP_TRANSPORT_HEALTH_KEY,
    JSON.stringify(payload),
    "EX",
    smtpHealthTtlSeconds,
  );
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

const readSmtpHealth = async (): Promise<SmtpTransportHealth | null> => {
  const raw = await redis.get(SMTP_TRANSPORT_HEALTH_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SmtpTransportHealth>;
    if (typeof parsed.at !== "string" || typeof parsed.ok !== "boolean") return null;
    return {
      at: parsed.at,
      ok: parsed.ok,
      error: typeof parsed.error === "string" ? parsed.error : null,
    };
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

const ageMs = (value?: string | null): number | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Math.max(0, Date.now() - date.getTime());
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
    smtpTransport,
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
    readSmtpHealth(),
  ]);

  const smtp = smtpConfiguration();
  const heartbeatAgeMs = ageMs(heartbeat?.at);
  const workerAlive = heartbeatAgeMs !== null && heartbeatAgeMs <= heartbeatFreshnessMs;

  const smtpCheckAgeMs = ageMs(smtpTransport?.at);
  const smtpCheckFresh = smtpCheckAgeMs !== null && smtpCheckAgeMs <= smtpHealthFreshnessMs;
  const smtpConnectivityHealthy = SMTP_VERIFY_ON_STARTUP
    ? Boolean(smtpTransport?.ok && smtpCheckFresh)
    : null;

  const oldestPendingAgeMs = oldestPending
    ? Math.max(0, Date.now() - oldestPending.createdAt.getTime())
    : null;

  const workerHealthy = !OUTBOX_WORKER_REQUIRED || workerAlive;
  const smtpHealthy = smtp.configured && (smtpConnectivityHealthy !== false);
  const healthy = smtpHealthy && workerHealthy && deadLetterCount === 0;

  return {
    healthy,
    status: healthy ? "ok" : "degraded",
    smtp: {
      ...smtp,
      verifyOnStartup: SMTP_VERIFY_ON_STARTUP,
      healthcheckIntervalMs: SMTP_HEALTHCHECK_INTERVAL_MS,
      connectivity: {
        healthy: smtpConnectivityHealthy,
        checkedAt: smtpTransport?.at ?? null,
        ageMs: smtpCheckAgeMs,
        error: smtpTransport?.error ?? null,
      },
    },
    worker: {
      required: OUTBOX_WORKER_REQUIRED,
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
