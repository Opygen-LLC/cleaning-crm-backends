import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../prisma/prisma";
import { getTracePropagationMetadata, traceAsyncOperation } from "../monitoring/requestTrace";

export const AUTH_EMAIL_OUTBOX_TOPIC = Object.freeze({
  EMAIL_VERIFICATION_REQUESTED: "AUTH_EMAIL_VERIFICATION_REQUESTED",
} as const);

export interface EmailVerificationOutboxPayload {
  userId: string;
  email: string;
}

const withTraceMetadata = <T extends Record<string, unknown>>(payload: T) => {
  const trace = getTracePropagationMetadata();
  return trace ? { ...payload, _trace: trace } : payload;
};

const enqueueEmailVerificationTx = async (
  db: Prisma.TransactionClient,
  payload: EmailVerificationOutboxPayload,
  options: { dedupeKey?: string | null } = {},
) => traceAsyncOperation("queue", "outbox.enqueue.auth-email", () => db.outboxEvent.create({
  data: {
    topic: AUTH_EMAIL_OUTBOX_TOPIC.EMAIL_VERIFICATION_REQUESTED,
    dedupeKey: options.dedupeKey ?? null,
    payload: withTraceMetadata({
      userId: payload.userId,
      email: payload.email.trim().toLowerCase(),
    }),
  },
  select: { id: true },
}));

const enqueueEmailVerification = async (
  payload: EmailVerificationOutboxPayload,
) => traceAsyncOperation("queue", "outbox.enqueue.auth-email", () => prisma.outboxEvent.create({
  data: {
    topic: AUTH_EMAIL_OUTBOX_TOPIC.EMAIL_VERIFICATION_REQUESTED,
    payload: withTraceMetadata({
      userId: payload.userId,
      email: payload.email.trim().toLowerCase(),
    }),
  },
  select: { id: true },
}));

export const AuthEmailOutbox = {
  enqueueEmailVerificationTx,
  enqueueEmailVerification,
};
