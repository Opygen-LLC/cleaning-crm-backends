import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../prisma/prisma";

export const AUTH_EMAIL_OUTBOX_TOPIC = Object.freeze({
  EMAIL_VERIFICATION_REQUESTED: "AUTH_EMAIL_VERIFICATION_REQUESTED",
} as const);

export interface EmailVerificationOutboxPayload {
  userId: string;
  email: string;
}

const enqueueEmailVerificationTx = async (
  db: Prisma.TransactionClient,
  payload: EmailVerificationOutboxPayload,
  options: { dedupeKey?: string | null } = {},
) => db.outboxEvent.create({
  data: {
    topic: AUTH_EMAIL_OUTBOX_TOPIC.EMAIL_VERIFICATION_REQUESTED,
    dedupeKey: options.dedupeKey ?? null,
    payload: {
      userId: payload.userId,
      email: payload.email.trim().toLowerCase(),
    },
  },
  select: { id: true },
});

const enqueueEmailVerification = async (
  payload: EmailVerificationOutboxPayload,
) => prisma.outboxEvent.create({
  data: {
    topic: AUTH_EMAIL_OUTBOX_TOPIC.EMAIL_VERIFICATION_REQUESTED,
    payload: {
      userId: payload.userId,
      email: payload.email.trim().toLowerCase(),
    },
  },
  select: { id: true },
});

export const AuthEmailOutbox = {
  enqueueEmailVerificationTx,
  enqueueEmailVerification,
};
