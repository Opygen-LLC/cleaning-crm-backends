import {
  NEXT_REVALIDATE_SECRET,
  NEXT_REVALIDATE_TIMEOUT_MS,
  NEXT_REVALIDATE_URL,
} from "../../config/ENV";
import logger from "../logger";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../prisma/prisma";
import { getTracePropagationMetadata, traceAsyncOperation } from "../monitoring/requestTrace";

export const PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC = Object.freeze({
  INVALIDATION_REQUESTED: "PUBLIC_WEBSITE_CACHE_INVALIDATION_REQUESTED",
} as const);

export interface PublicWebsiteCacheInvalidationPayload {
  websiteId: string;
  /** Versioned extension of the SAME outbox topic. Legacy callback rows still work. */
  delivery?: { version: 1; adminId: string; revision: number | null };
  /** Canonical tenant identifier. For Cleaning CRM this is normally the canonical subdomain label. */
  tenantIdentifier?: string | null;
  /** Historical subdomain aliases and routable custom-domain aliases when available. */
  tenantIdentifiers?: string[] | null;
  reason?: string | null;
}

export interface PublicWebsiteCacheRevalidationResult {
  configured: boolean;
  delivered: boolean;
  queued: boolean;
}

const WEBSITE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TENANT_IDENTIFIERS = 20;
const MAX_TENANT_IDENTIFIER_LENGTH = 180;

const withTraceMetadata = <T extends Record<string, unknown>>(payload: T) => {
  const trace = getTracePropagationMetadata();
  return trace ? { ...payload, _trace: trace } : payload;
};

const normalizeTenantIdentifier = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > MAX_TENANT_IDENTIFIER_LENGTH) return null;
  return normalized;
};

const normalizeTenantIdentifiers = (
  tenantIdentifier: unknown,
  tenantIdentifiers: unknown,
): string[] => {
  const values = [
    normalizeTenantIdentifier(tenantIdentifier),
    ...(Array.isArray(tenantIdentifiers)
      ? tenantIdentifiers.map((value) => normalizeTenantIdentifier(value))
      : []),
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(values)).slice(0, MAX_TENANT_IDENTIFIERS);
};

const normalizePayload = (
  payload: PublicWebsiteCacheInvalidationPayload,
): PublicWebsiteCacheInvalidationPayload => {
  const websiteId = payload.websiteId.trim();
  if (!WEBSITE_ID_PATTERN.test(websiteId)) {
    throw new Error("Public website cache invalidation payload has an invalid websiteId");
  }

  const tenantIdentifiers = normalizeTenantIdentifiers(
    payload.tenantIdentifier,
    payload.tenantIdentifiers,
  );
  const canonicalTenantIdentifier = tenantIdentifiers[0] ?? null;

  return {
    websiteId,
    ...(payload.delivery ? { delivery: payload.delivery } : {}),
    tenantIdentifier: canonicalTenantIdentifier,
    tenantIdentifiers,
    reason: payload.reason?.trim().slice(0, 120) || "website-projection-invalidated",
  };
};

/**
 * Parse a durable outbox payload. Older rows that only contain tenantIdentifier
 * remain valid; newer rows can carry the complete identifier/alias set.
 */
export const parsePublicWebsiteCacheInvalidationPayload = (
  payload: unknown,
): PublicWebsiteCacheInvalidationPayload => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid public website cache invalidation payload");
  }

  const value = payload as Record<string, unknown>;
  const delivery = value.delivery as PublicWebsiteCacheInvalidationPayload["delivery"];
  if (delivery && (delivery.version !== 1 || typeof delivery.adminId !== "string" || !delivery.adminId ||
      !(delivery.revision === null || (Number.isSafeInteger(delivery.revision) && delivery.revision > 0)))) {
    throw new Error("Invalid publication delivery outbox payload");
  }
  return normalizePayload({
    ...(delivery ? { delivery } : {}),
    websiteId: typeof value.websiteId === "string" ? value.websiteId : "",
    tenantIdentifier: value.tenantIdentifier as string | null | undefined,
    tenantIdentifiers: Array.isArray(value.tenantIdentifiers)
      ? value.tenantIdentifiers.filter((item): item is string => typeof item === "string")
      : null,
    reason: typeof value.reason === "string" ? value.reason : null,
  });
};

/**
 * Deliver one signed Next.js cache invalidation immediately. This function
 * throws on transport/auth/HTTP failure so the durable worker can reuse the
 * exact same delivery contract and apply its retry/backoff policy.
 */
const deliver = async (payload: PublicWebsiteCacheInvalidationPayload): Promise<void> => {
  if (!NEXT_REVALIDATE_URL || !NEXT_REVALIDATE_SECRET) {
    throw new Error("Next public cache revalidation is not configured");
  }

  const normalized = normalizePayload(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NEXT_REVALIDATE_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(NEXT_REVALIDATE_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-revalidate-secret": NEXT_REVALIDATE_SECRET,
      },
      body: JSON.stringify(normalized),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Next cache revalidation failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Queue a durable retry after a direct Next.js revalidation fails. Publication
 * has already committed when this helper runs, so queue failure is logged but
 * never turns a successful website mutation into an HTTP failure.
 */
const enqueue = async (payload: PublicWebsiteCacheInvalidationPayload): Promise<boolean> => {
  if (!NEXT_REVALIDATE_URL || !NEXT_REVALIDATE_SECRET) return false;

  let normalized: PublicWebsiteCacheInvalidationPayload;
  try {
    normalized = normalizePayload(payload);
  } catch (error) {
    logger.warn("Public website cache invalidation payload was rejected", {
      websiteId: payload.websiteId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  try {
    await traceAsyncOperation("queue", "outbox.enqueue.website-cache", () =>
      prisma.outboxEvent.create({
        data: {
          topic: PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC.INVALIDATION_REQUESTED,
          payload: withTraceMetadata({
            websiteId: normalized.websiteId,
            tenantIdentifier: normalized.tenantIdentifier ?? null,
            tenantIdentifiers: normalized.tenantIdentifiers ?? [],
            reason: normalized.reason,
          }),
          maxAttempts: 8,
        },
        select: { id: true },
      }),
    );
    return true;
  } catch (error) {
    logger.warn("Public website cache invalidation could not be queued", {
      websiteId: normalized.websiteId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

/**
 * Normal correctness path: invalidate Next.js immediately after the database,
 * Redis projection and routing caches are committed/invalidated. The outbox is
 * only a recovery path for a timeout, deploy window, auth mismatch or frontend
 * outage. Missing callback configuration remains tolerated outside production;
 * production startup validation already requires a valid URL + 32-char secret.
 */
const triggerWithFallback = async (
  payload: PublicWebsiteCacheInvalidationPayload,
): Promise<PublicWebsiteCacheRevalidationResult> => {
  if (!NEXT_REVALIDATE_URL || !NEXT_REVALIDATE_SECRET) {
    return { configured: false, delivered: false, queued: false };
  }

  try {
    await traceAsyncOperation("external", "frontend.cache-revalidation.direct", () => deliver(payload));
    return { configured: true, delivered: true, queued: false };
  } catch (error) {
    logger.warn("Direct public website cache revalidation failed; queuing durable retry", {
      websiteId: payload.websiteId,
      error: error instanceof Error ? error.message : String(error),
    });
    const queued = await enqueue(payload);
    return { configured: true, delivered: false, queued };
  }
};

export const publicationDeliveryDedupeKey = (websiteId: string, revision: number) =>
  `website-publication:${websiteId}:${revision}`;

/** Never catch this error: failure to persist delivery must roll back publication. */
const enqueueDeliveryTx = async (
  tx: Prisma.TransactionClient,
  input: PublicWebsiteCacheInvalidationPayload & { delivery: NonNullable<PublicWebsiteCacheInvalidationPayload["delivery"]> },
  dedupeKey = input.delivery.revision === null
    ? `website-lifecycle:${input.websiteId}:${randomUUID()}`
    : publicationDeliveryDedupeKey(input.websiteId, input.delivery.revision),
) => {
  const payload = withTraceMetadata(normalizePayload(input) as unknown as Record<string, unknown>) as Prisma.InputJsonObject;
  return traceAsyncOperation("queue", "outbox.enqueue.website-publication", () => tx.outboxEvent.upsert({
    where: { dedupeKey },
    create: {
      topic: PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC.INVALIDATION_REQUESTED,
      dedupeKey, payload, maxAttempts: 8,
      // Give the immediate path a head start. A crash after COMMIT still leaves
      // a claimable row for the existing worker, with its normal retry policy.
      nextAttemptAt: new Date(Date.now() + 15_000),
    },
    update: {},
    select: { id: true, payload: true },
  }));
};

const enqueueTenantDeliveryTx = async (tx: Prisma.TransactionClient, adminId: string, reason: string) => {
  const website = await tx.businessWebsite.findUnique({
    where: { adminId },
    select: { id: true, subdomain: true, publishedRevisionNumber: true,
      subdomainAliases: { select: { subdomain: true } }, domains: { select: { domain: true } } },
  });
  if (!website) return null;
  return enqueueDeliveryTx(tx, {
    websiteId: website.id, tenantIdentifier: website.subdomain,
    tenantIdentifiers: [website.subdomain, ...website.subdomainAliases.map(a => a.subdomain), ...website.domains.map(d => d.domain)],
    reason, delivery: { version: 1, adminId, revision: website.publishedRevisionNumber },
  }, `website-lifecycle:${website.id}:${randomUUID()}`);
};

export const PublicWebsiteCacheOutbox = { enqueue, enqueueDeliveryTx, enqueueTenantDeliveryTx };
export const PublicWebsiteCacheRevalidation = { deliver, triggerWithFallback };
