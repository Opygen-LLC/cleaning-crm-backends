import { auth } from "../lib/auth";
import logger from "../lib/logger";
import { getRequestTrace, runWithRequestTrace, traceAsyncOperation } from "../lib/monitoring/requestTrace";
import { prisma } from "../lib/prisma/prisma";
import {
  NEXT_REVALIDATE_SECRET,
  NEXT_REVALIDATE_TIMEOUT_MS,
  NEXT_REVALIDATE_URL,
  NODE_ENV,
  OUTBOX_LOCK_TIMEOUT_MS,
  OUTBOX_WORKER_BATCH_SIZE,
  OUTBOX_WORKER_ENABLED,
  OUTBOX_WORKER_POLL_MS,
} from "../config/ENV";
import {
  AUTH_EMAIL_OUTBOX_TOPIC,
  type EmailVerificationOutboxPayload,
} from "../lib/outbox/authEmailOutbox";
import {
  PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC,
  type PublicWebsiteCacheInvalidationPayload,
} from "../lib/outbox/publicWebsiteCacheOutbox";

type ClaimedOutboxEvent = {
  id: string;
  topic: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
};

const MAX_BACKOFF_MS = 15 * 60 * 1000;
const BASE_BACKOFF_MS = 5_000;

let timer: NodeJS.Timeout | null = null;
let processing = false;

const normalizeError = (error: unknown) => {
  if (error instanceof Error) return error.message.slice(0, 2_000);
  return String(error).slice(0, 2_000);
};

const extractTraceMetadata = (payload: unknown): { traceId: string; requestId: string } | null => {
  if (!payload || typeof payload !== "object") return null;
  const trace = (payload as Record<string, unknown>)._trace;
  if (!trace || typeof trace !== "object") return null;
  const value = trace as Record<string, unknown>;
  const traceId = typeof value.traceId === "string" ? value.traceId : "";
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  if (!/^[0-9a-f]{32}$/i.test(traceId) || !requestId || requestId.length > 128) return null;
  return { traceId: traceId.toLowerCase(), requestId };
};

const claimBatch = async (): Promise<ClaimedOutboxEvent[]> => {
  const lockTimeoutSeconds = Math.max(1, Math.ceil(OUTBOX_LOCK_TIMEOUT_MS / 1000));
  const batchSize = Math.max(1, OUTBOX_WORKER_BATCH_SIZE);

  // FOR UPDATE SKIP LOCKED makes this safe when several API/worker instances
  // poll the same durable outbox. Only one process can claim a row at a time.
  return prisma.$queryRaw<ClaimedOutboxEvent[]>`
    WITH candidates AS (
      SELECT "id"
      FROM "outbox_event"
      WHERE "processedAt" IS NULL
        AND "attempts" < "maxAttempts"
        AND "nextAttemptAt" <= NOW()
        AND "status" IN ('PENDING', 'RETRY', 'PROCESSING')
        AND (
          "lockedAt" IS NULL
          OR "lockedAt" < NOW() - (${lockTimeoutSeconds} * INTERVAL '1 second')
        )
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "outbox_event" AS event
    SET
      "status" = 'PROCESSING',
      "lockedAt" = NOW(),
      "attempts" = event."attempts" + 1,
      "updatedAt" = NOW()
    FROM candidates
    WHERE event."id" = candidates."id"
    RETURNING
      event."id",
      event."topic",
      event."payload",
      event."attempts",
      event."maxAttempts"
  `;
};

const parseVerificationPayload = (payload: unknown): EmailVerificationOutboxPayload => {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid verification outbox payload");
  }

  const value = payload as Record<string, unknown>;
  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  if (!userId || !email) throw new Error("Verification outbox payload is missing userId/email");
  return { userId, email };
};

const deliverVerificationEmail = async (payload: EmailVerificationOutboxPayload) => {
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { email: true, emailVerified: true },
  });

  // User deletion or successful verification makes the event obsolete. Treat
  // that as successful consumption rather than retrying a dead message.
  if (!user || user.emailVerified) return;
  if (user.email.toLowerCase() !== payload.email) {
    throw new Error("Verification outbox email no longer matches the user record");
  }

  // Better Auth remains the source of truth for OTP generation/expiry/storage.
  // Its email plugin awaits SMTP in worker context, so delivery failure bubbles
  // up and the durable outbox retries instead of losing the verification mail.
  await auth.api.sendVerificationOTP({
    body: { email: user.email, type: "email-verification" },
  });
};

const parsePublicWebsiteCachePayload = (payload: unknown): PublicWebsiteCacheInvalidationPayload => {
  if (!payload || typeof payload !== "object") throw new Error("Invalid public website cache invalidation payload");
  const value = payload as Record<string, unknown>;
  const websiteId = typeof value.websiteId === "string" ? value.websiteId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(websiteId)) {
    throw new Error("Public website cache invalidation payload has an invalid websiteId");
  }
  return {
    websiteId,
    tenantIdentifier: typeof value.tenantIdentifier === "string" ? value.tenantIdentifier.trim().toLowerCase() : null,
    reason: typeof value.reason === "string" ? value.reason.trim().slice(0, 120) : null,
  };
};

const deliverPublicWebsiteCacheInvalidation = async (payload: PublicWebsiteCacheInvalidationPayload) => {
  if (!NEXT_REVALIDATE_URL || !NEXT_REVALIDATE_SECRET) {
    throw new Error("Next public cache revalidation is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NEXT_REVALIDATE_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(NEXT_REVALIDATE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-revalidate-secret": NEXT_REVALIDATE_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Next cache revalidation failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const processEvent = async (event: ClaimedOutboxEvent) => {
  switch (event.topic) {
    case AUTH_EMAIL_OUTBOX_TOPIC.EMAIL_VERIFICATION_REQUESTED:
      await traceAsyncOperation("external", "email.verification-delivery", () =>
        deliverVerificationEmail(parseVerificationPayload(event.payload)),
      );
      return;
    case PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC.INVALIDATION_REQUESTED:
      await traceAsyncOperation("external", "frontend.cache-revalidation", () =>
        deliverPublicWebsiteCacheInvalidation(parsePublicWebsiteCachePayload(event.payload)),
      );
      return;
    default:
      throw new Error(`Unsupported outbox topic: ${event.topic}`);
  }
};

const markProcessed = async (id: string) => {
  await prisma.outboxEvent.update({
    where: { id },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      lockedAt: null,
      lastError: null,
    },
  });
};

const markFailed = async (event: ClaimedOutboxEvent, error: unknown) => {
  const dead = event.attempts >= event.maxAttempts;
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, event.attempts - 1));
  const jitter = Math.floor(Math.random() * Math.min(5_000, Math.max(250, exponential * 0.15)));
  const nextAttemptAt = new Date(Date.now() + exponential + jitter);

  await prisma.outboxEvent.update({
    where: { id: event.id },
    data: {
      status: dead ? "DEAD" : "RETRY",
      lockedAt: null,
      nextAttemptAt,
      lastError: normalizeError(error),
    },
  });

  if (NODE_ENV === "production") {
    logger.error("outbox_delivery_failed", {
      event: "outbox_delivery_failed",
      outboxEventId: event.id,
      topic: event.topic,
      attempt: event.attempts,
      maxAttempts: event.maxAttempts,
      dead,
      errorMessage: normalizeError(error),
    });
  } else {
    logger.error(
      `Background delivery failed — ${event.topic} · attempt ${event.attempts}/${event.maxAttempts}${dead ? " · moved to dead-letter state" : " · will retry"}: ${normalizeError(error)}`,
    );
  }
};

export const processEmailOutboxOnce = async () => {
  if (processing) return { claimed: 0 };
  processing = true;
  try {
    const events = await claimBatch();
    for (const event of events) {
      const execute = async () => {
        try {
          await processEvent(event);
          await markProcessed(event.id);
          const trace = getRequestTrace();
          if (NODE_ENV === "production") {
            logger.info("outbox_event_processed", {
              event: "outbox_event_processed",
              outboxEventId: event.id,
              topic: event.topic,
              requestId: trace?.requestId ?? null,
              traceId: trace?.traceId ?? null,
              dbDurationMs: trace ? Math.round(trace.dbDurationMs * 10) / 10 : 0,
              externalDurationMs: trace ? Math.round(trace.externalDurationMs * 10) / 10 : 0,
            });
          } else if (event.topic !== AUTH_EMAIL_OUTBOX_TOPIC.EMAIL_VERIFICATION_REQUESTED) {
            logger.info(`Background job completed — ${event.topic}.`);
          }
        } catch (error) {
          await markFailed(event, error);
        }
      };

      const propagation = extractTraceMetadata(event.payload);
      if (propagation) await runWithRequestTrace(propagation, execute);
      else await execute();
    }
    return { claimed: events.length };
  } finally {
    processing = false;
  }
};

export const startEmailOutboxWorker = () => {
  if (!OUTBOX_WORKER_ENABLED || timer) return;

  const tick = () => {
    void processEmailOutboxOnce().catch((error) => {
      logger.error(`Background delivery worker failed — ${normalizeError(error)}`);
    });
  };

  // Dedicated worker process: keep the polling timer referenced so the worker
  // remains alive even when the DB pool is momentarily idle.
  tick();
  timer = setInterval(tick, OUTBOX_WORKER_POLL_MS);
  logger.info(`Background delivery worker ready — poll ${OUTBOX_WORKER_POLL_MS}ms, batch ${OUTBOX_WORKER_BATCH_SIZE}.`);
};

export const stopEmailOutboxWorker = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};
