import {
  NEXT_REVALIDATE_SECRET,
  NEXT_REVALIDATE_TIMEOUT_MS,
  NEXT_REVALIDATE_URL,
} from "../../config/ENV";
import logger from "../logger";
import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../prisma/prisma";
import { getTracePropagationMetadata, traceAsyncOperation } from "../monitoring/requestTrace";

export const PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC = Object.freeze({
  INVALIDATION_REQUESTED: "PUBLIC_WEBSITE_CACHE_INVALIDATION_REQUESTED",
  // A distinct topic in the SAME outbox prevents an older worker from treating
  // full publication delivery as just a successful Next revalidation callback.
  DELIVERY_REQUESTED: "PUBLIC_WEBSITE_DELIVERY_REQUESTED",
} as const);

export interface WebsitePublicationWork {
  adminId: string;
  revisionNumber: number;
}

export const publicationDeliveryDedupeKey = (websiteId: string, revisionNumber: number) =>
  `website-publication:${websiteId}:${revisionNumber}`;

export interface PublicWebsiteCacheInvalidationPayload {
  websiteId: string;
  /** Presence selects full access/routing/projection delivery in the same outbox. */
  publication?: WebsitePublicationWork;
  accessChange?: { adminId: string };
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

  if (payload.publication && (
    !payload.publication.adminId || !Number.isSafeInteger(payload.publication.revisionNumber) ||
    payload.publication.revisionNumber < 1
  )) throw new Error("Invalid publication delivery metadata");

  if (payload.accessChange && !payload.accessChange.adminId) throw new Error("Invalid access delivery metadata");

  const tenantIdentifiers = normalizeTenantIdentifiers(
    payload.tenantIdentifier,
    payload.tenantIdentifiers,
  );
  const canonicalTenantIdentifier = tenantIdentifiers[0] ?? null;

  return {
    websiteId,
    ...(payload.publication ? { publication: payload.publication } : {}),
    ...(payload.accessChange ? { accessChange: payload.accessChange } : {}),
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
  return normalizePayload({
    websiteId: typeof value.websiteId === "string" ? value.websiteId : "",
    tenantIdentifier: value.tenantIdentifier as string | null | undefined,
    tenantIdentifiers: Array.isArray(value.tenantIdentifiers)
      ? value.tenantIdentifiers.filter((item): item is string => typeof item === "string")
      : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    ...(value.publication ? { publication: value.publication as WebsitePublicationWork } : {}),
    ...(value.accessChange ? { accessChange: value.accessChange as { adminId: string } } : {}),
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

/** Must be called inside the snapshot/onboarding transaction. No network I/O. */
const enqueuePublicationTx = async (
  tx: Prisma.TransactionClient,
  payload: PublicWebsiteCacheInvalidationPayload & { publication: WebsitePublicationWork },
) => {
  const normalized = normalizePayload(payload);
  return traceAsyncOperation("queue", "outbox.enqueue.publication", () => tx.outboxEvent.upsert({
    where: { dedupeKey: publicationDeliveryDedupeKey(payload.websiteId, payload.publication.revisionNumber) },
    create: {
      topic: PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC.DELIVERY_REQUESTED,
      dedupeKey: publicationDeliveryDedupeKey(payload.websiteId, payload.publication.revisionNumber),
      payload: withTraceMetadata({ ...normalized }) as Prisma.InputJsonValue,
      maxAttempts: 8,
    },
    // A duplicate launch must not steal a worker lease or create another row.
    update: {},
    select: { id: true, status: true },
  }));
};

/** A lifecycle change is durable with its tenant transaction, even for a draft.
 * Distinct changes must not deduplicate against a previous publication receipt.
 */
const enqueueTenantAccessChangeTx = async (tx: Prisma.TransactionClient, adminId: string, reason: string) => {
  const website = await tx.businessWebsite.findUnique({
    where: { adminId },
    select: { id: true, subdomain: true, subdomainAliases: { select: { subdomain: true } }, domains: { select: { domain: true } } },
  });
  if (!website) return null;
  const payload = normalizePayload({
    websiteId: website.id, accessChange: { adminId }, reason,
    tenantIdentifier: website.subdomain,
    tenantIdentifiers: [website.subdomain, ...website.subdomainAliases.map((item) => item.subdomain), ...website.domains.map((item) => item.domain)],
  });
  const event = await tx.outboxEvent.create({
    data: { topic: PUBLIC_WEBSITE_CACHE_OUTBOX_TOPIC.DELIVERY_REQUESTED, payload: withTraceMetadata({ ...payload }) as Prisma.InputJsonValue, maxAttempts: 8 },
    select: { id: true },
  });
  return { id: event.id, payload };
};

/** The direct path never takes ownership of a row already leased by a worker. */
const acknowledgePublication = async (id: string): Promise<boolean> => {
  try {
    const result = await prisma.outboxEvent.updateMany({
      where: { id, status: { in: ["PENDING", "RETRY", "PROCESSED", "DEAD"] }, lockedAt: null },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });
    if (result.count > 0) return true;
    return (await prisma.outboxEvent.findUnique({ where: { id }, select: { status: true } }))?.status === "PROCESSED";
  } catch { return false; }
};

const retainPublicationRetry = async (id: string): Promise<boolean> => {
  try {
    // Reopen a completed/dead receipt when a later idempotent launch detects a
    // delivery outage. Never reset a pending attempt or a worker's active lease.
    await prisma.outboxEvent.updateMany({
      where: { id, status: { in: ["PROCESSED", "DEAD"] }, lockedAt: null },
      data: { status: "PENDING", processedAt: null, attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    const event = await prisma.outboxEvent.findUnique({ where: { id }, select: { status: true } });
    return Boolean(event && ["PENDING", "RETRY", "PROCESSING"].includes(event.status));
  } catch { return false; }
};

export const PublicWebsiteCacheOutbox = { enqueue, enqueuePublicationTx, enqueueTenantAccessChangeTx, acknowledgePublication, retainPublicationRetry };
export const PublicWebsiteCacheRevalidation = { deliver, triggerWithFallback };
