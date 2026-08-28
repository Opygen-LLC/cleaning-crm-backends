import { NEXT_REVALIDATE_SECRET, NEXT_REVALIDATE_URL } from "../../config/ENV";
import logger from "../logger";
import { prisma } from "../prisma/prisma";
import { getTracePropagationMetadata, traceAsyncOperation } from "../monitoring/requestTrace";

export const PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC = Object.freeze({
  INVALIDATION_REQUESTED: "PUBLIC_WEBSITE_CACHE_INVALIDATION_REQUESTED",
} as const);

export interface PublicWebsiteCacheInvalidationPayload {
  websiteId: string;
  tenantIdentifier?: string | null;
  reason?: string | null;
}

const withTraceMetadata = <T extends Record<string, unknown>>(payload: T) => {
  const trace = getTracePropagationMetadata();
  return trace ? { ...payload, _trace: trace } : payload;
};

/**
 * Queue a durable Next.js cache invalidation after a public projection mutation.
 * The source mutation has already committed when this helper is called, so a
 * temporary outbox/database failure must never turn a successful admin action
 * into an HTTP error. The frontend's time-based safety window is the fallback.
 */
const enqueue = async (payload: PublicWebsiteCacheInvalidationPayload): Promise<boolean> => {
  // Local/test environments can deliberately run without the Next callback.
  // Production startup validation requires both values.
  if (!NEXT_REVALIDATE_URL || !NEXT_REVALIDATE_SECRET) return false;

  try {
    await traceAsyncOperation("queue", "outbox.enqueue.website-cache", () => prisma.outboxEvent.create({
      data: {
        topic: PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC.INVALIDATION_REQUESTED,
        payload: withTraceMetadata({
          websiteId: payload.websiteId,
          tenantIdentifier: payload.tenantIdentifier?.trim().toLowerCase() || null,
          reason: payload.reason?.trim().slice(0, 120) || "website-projection-invalidated",
        }),
        maxAttempts: 8,
      },
      select: { id: true },
    }));
    return true;
  } catch (error) {
    logger.warn("Public website cache invalidation could not be queued", {
      websiteId: payload.websiteId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

export const PublicWebsiteCacheOutbox = { enqueue };
