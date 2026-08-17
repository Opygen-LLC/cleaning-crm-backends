import { auth } from "../lib/auth";
import logger from "../lib/logger";
import { prisma } from "../lib/prisma/prisma";
import {
  OUTBOX_LOCK_TIMEOUT_MS,
  OUTBOX_WORKER_BATCH_SIZE,
  OUTBOX_WORKER_ENABLED,
  OUTBOX_WORKER_POLL_MS,
} from "../config/ENV";
import {
  AUTH_EMAIL_OUTBOX_TOPIC,
  type EmailVerificationOutboxPayload,
} from "../lib/outbox/authEmailOutbox";

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

const processEvent = async (event: ClaimedOutboxEvent) => {
  switch (event.topic) {
    case AUTH_EMAIL_OUTBOX_TOPIC.EMAIL_VERIFICATION_REQUESTED:
      await deliverVerificationEmail(parseVerificationPayload(event.payload));
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

  logger.error("Email outbox delivery failed", {
    outboxEventId: event.id,
    topic: event.topic,
    attempt: event.attempts,
    maxAttempts: event.maxAttempts,
    dead,
    error,
  });
};

export const processEmailOutboxOnce = async () => {
  if (processing) return { claimed: 0 };
  processing = true;
  try {
    const events = await claimBatch();
    for (const event of events) {
      try {
        await processEvent(event);
        await markProcessed(event.id);
      } catch (error) {
        await markFailed(event, error);
      }
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
      logger.error("Email outbox worker tick failed", { error });
    });
  };

  // Process immediately after boot, then continue polling. `unref` allows a
  // graceful process shutdown without the timer keeping Node alive by itself.
  tick();
  timer = setInterval(tick, OUTBOX_WORKER_POLL_MS);
  timer.unref();
  logger.info(`[OUTBOX] email worker started (poll=${OUTBOX_WORKER_POLL_MS}ms, batch=${OUTBOX_WORKER_BATCH_SIZE})`);
};

export const stopEmailOutboxWorker = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};
