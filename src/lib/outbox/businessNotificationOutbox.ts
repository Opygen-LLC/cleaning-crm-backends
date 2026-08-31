import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../prisma/prisma";
import { getTracePropagationMetadata, traceAsyncOperation } from "../monitoring/requestTrace";
import {
  getBusinessNotificationDefinition,
  type BusinessNotificationTemplateKey,
} from "../notifications/businessNotificationRegistry";

export const BUSINESS_NOTIFICATION_OUTBOX_TOPIC = Object.freeze({
  DELIVERY_REQUESTED: "BUSINESS_NOTIFICATION_DELIVERY_REQUESTED",
} as const);

export type BusinessNotificationVariables = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface BusinessNotificationEnqueueInput {
  adminId: string;
  eventKey: string;
  templateKey: BusinessNotificationTemplateKey;
  recipientEmail: string;
  recipientUserId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  variables: BusinessNotificationVariables;
  scheduledFor?: Date;
}

const cleanVariables = (variables: BusinessNotificationVariables) =>
  Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [
      key,
      value === undefined ? "" : value === null ? "" : String(value),
    ]),
  );

const withTraceMetadata = <T extends Record<string, unknown>>(payload: T) => {
  const trace = getTracePropagationMetadata();
  return trace ? { ...payload, _trace: trace } : payload;
};

const normalizeEventKey = (value: string) => value.trim().slice(0, 240);

const enqueueTx = async (
  db: Prisma.TransactionClient,
  input: BusinessNotificationEnqueueInput,
) => {
  const definition = getBusinessNotificationDefinition(input.templateKey);
  const eventKey = normalizeEventKey(input.eventKey);
  if (!eventKey) throw new Error("Business notification eventKey is required");

  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  if (!recipientEmail) throw new Error("Business notification recipientEmail is required");

  const prefs = await db.notificationPreference.findUnique({ where: { adminId: input.adminId } });
  const configured = prefs
    ? (prefs as unknown as Record<string, unknown>)[definition.preferenceKey]
    : undefined;
  const enabled = typeof configured === "boolean" ? configured : definition.defaultEnabled;
  if (!enabled) return { queued: false as const, deliveryId: null };

  const scheduledFor = input.scheduledFor ?? new Date();
  const delivery = await db.notificationDelivery.upsert({
    where: { eventKey },
    create: {
      adminId: input.adminId,
      eventKey,
      event: definition.event,
      templateKey: input.templateKey,
      recipientType: definition.recipient,
      recipientEmail,
      recipientUserId: input.recipientUserId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      payload: cleanVariables(input.variables) as Prisma.InputJsonValue,
      scheduledFor,
      status: "QUEUED",
      attempts: 0,
      maxAttempts: definition.maxAttempts,
    },
    update: {},
    select: { id: true, status: true },
  });

  const dedupeKey = `business-notification:${eventKey}`;
  await db.outboxEvent.upsert({
    where: { dedupeKey },
    create: {
      topic: BUSINESS_NOTIFICATION_OUTBOX_TOPIC.DELIVERY_REQUESTED,
      dedupeKey,
      payload: withTraceMetadata({ deliveryId: delivery.id }) as Prisma.InputJsonValue,
      maxAttempts: definition.maxAttempts,
      nextAttemptAt: scheduledFor,
    },
    update: {},
    select: { id: true },
  });

  return { queued: true as const, deliveryId: delivery.id };
};

const enqueue = async (input: BusinessNotificationEnqueueInput) =>
  traceAsyncOperation("queue", "outbox.enqueue.business-notification", () =>
    prisma.$transaction((tx) => enqueueTx(tx, input)),
  );

export const BusinessNotificationOutbox = {
  enqueue,
  enqueueTx,
};
