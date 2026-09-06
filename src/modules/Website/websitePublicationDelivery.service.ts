import { WEBSITE_BASE_DOMAIN, NEXT_REVALIDATE_URL, NEXT_REVALIDATE_SECRET } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import type { Prisma } from "../../generated/prisma/client";
import logger from "../../lib/logger";
import { getTracePropagationMetadata, traceAsyncOperation } from "../../lib/monitoring/requestTrace";
import {
  PublicWebsiteCacheRevalidation, parsePublicWebsiteCacheInvalidationPayload,
  type PublicWebsiteCacheInvalidationPayload,
} from "../../lib/outbox/publicWebsiteCacheOutbox";
import { TenantAccessResolver } from "../Entitlement/tenantAccessResolver.service";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { PublicWebsiteService } from "./publicWebsite.service";

export type WebsiteDeliveryState = "draft" | "preparing" | "live" | "temporarily_unavailable";
export interface WebsitePublicationDelivery {
  cacheInvalidated: boolean;
  accessInvalidated: boolean;
  routingInvalidated: boolean;
  projectionInvalidated: boolean;
  revalidationTriggered: boolean;
  revalidationDelivered: boolean;
  revalidationQueued: boolean;
  projectionWarmed: boolean;
  canonicalHostVerified: boolean;
  projectionRevisionVerified: boolean;
  /** Delivered can be true for a suspended/unpublished site; ready cannot. */
  delivered: boolean;
  ready: boolean;
  state: WebsiteDeliveryState;
  revision: number | null;
  publicUrl: string | null;
  checkedAt: string;
  validUntil: string | null;
  reason: string | null;
}

const emptyOutcome = (): WebsitePublicationDelivery => ({
  cacheInvalidated: false, accessInvalidated: false, routingInvalidated: false,
  projectionInvalidated: false, revalidationTriggered: false,
  revalidationDelivered: false, revalidationQueued: true, projectionWarmed: false,
  canonicalHostVerified: false, projectionRevisionVerified: false,
  delivered: false, ready: false, state: "preparing", revision: null, publicUrl: null,
  checkedAt: new Date().toISOString(), validUntil: null, reason: null,
});

const loadIdentity = (websiteId: string) => prisma.businessWebsite.findUnique({
  where: { id: websiteId },
  select: { id: true, adminId: true, subdomain: true, status: true, publishedRevisionNumber: true,
    subdomainAliases: { select: { subdomain: true } }, domains: { select: { domain: true } } },
});
type Identity = NonNullable<Awaited<ReturnType<typeof loadIdentity>>>;

/** Exercises the exact public read paths, not merely the presence of a URL. */
const verify = async (website: Identity) => {
  if (!WEBSITE_BASE_DOMAIN) throw new Error("WEBSITE_BASE_DOMAIN_NOT_CONFIGURED");
  const platformHost = `${website.subdomain}.${WEBSITE_BASE_DOMAIN}`;
  const platform = await WebsiteHostResolverService.resolveHost(platformHost);
  if (platform.websiteId !== website.id || platform.availability !== "live" || platform.publishedRevisionNumber !== website.publishedRevisionNumber) throw new Error("CANONICAL_PLATFORM_HOST_NOT_READY");
  const canonical = platform.canonicalHost === platformHost
    ? platform : await WebsiteHostResolverService.resolveHost(platform.canonicalHost);
  if (canonical.websiteId !== website.id || canonical.availability !== "live" || canonical.isAlias || canonical.publishedRevisionNumber !== website.publishedRevisionNumber) {
    throw new Error("CANONICAL_HOST_NOT_READY");
  }
  const projection = await PublicWebsiteService.getPublicWebsiteById(website.id);
  if (projection.website.id !== website.id || projection.website.publishedRevisionNumber !== website.publishedRevisionNumber) {
    throw new Error("PUBLICATION_REVISION_MISMATCH");
  }
  // A successful SQL load is not proof that Redis warming succeeded.
  const warmed = await WebsiteProjectionCacheService.get<typeof projection>(website.id);
  const projectionWarmed = warmed?.website.id === website.id &&
    warmed.website.publishedRevisionNumber === website.publishedRevisionNumber;
  const current = await loadIdentity(website.id);
  if (!current || current.status !== "PUBLISHED" || current.publishedRevisionNumber !== website.publishedRevisionNumber) {
    throw new Error("PUBLICATION_CHANGED_DURING_DELIVERY");
  }
  // Verification itself can cross a subscription/override deadline or a
  // suspension. Never advertise readiness using the decision from its start.
  const validUntil = new Date(Math.min(Date.parse(platform.validUntil), Date.parse(canonical.validUntil))).toISOString();
  if (Date.parse(validUntil) <= Date.now() ||
      !await TenantAccessResolver.isCurrentGeneration(platform.organizationId, platform.accessGeneration) ||
      !await TenantAccessResolver.isCurrentGeneration(canonical.organizationId, canonical.accessGeneration)) {
    throw new Error("PUBLICATION_AUTHORIZATION_CHANGED_DURING_DELIVERY");
  }
  return { publicUrl: `https://${canonical.canonicalHost}`, projectionWarmed, validUntil };
};

/** Shared by the immediate request and the EXISTING durable outbox worker. */
const deliver = async (payload: PublicWebsiteCacheInvalidationPayload): Promise<WebsitePublicationDelivery> => {
  const result = emptyOutcome();
  try {
    const website = await loadIdentity(payload.websiteId);
    // Deleted websites still need the historical route/projection purge. A
    // successful frontend callback alone is not proof of backend invalidation.
    if (!website) {
      result.accessInvalidated = payload.delivery
        ? await TenantAccessResolver.invalidate(payload.delivery.adminId) : true;
      if (!result.accessInvalidated) throw new Error("TENANT_ACCESS_INVALIDATION_UNCONFIRMED");
      const identifiers = [...new Set([payload.tenantIdentifier, ...(payload.tenantIdentifiers ?? [])])]
        .filter((value): value is string => Boolean(value));
      const [labels, hosts, projection] = await Promise.all([
        WebsiteHostResolverService.invalidateSubdomains(identifiers.filter(value => !value.includes("."))),
        WebsiteHostResolverService.invalidateHosts(identifiers.filter(value => value.includes("."))),
        WebsiteProjectionCacheService.invalidateWebsite(payload.websiteId, payload.delivery?.adminId, { revalidateNext: false }),
      ]);
      result.routingInvalidated = labels && hosts;
      result.projectionInvalidated = projection.invalidated;
      result.cacheInvalidated = result.accessInvalidated && result.routingInvalidated && result.projectionInvalidated;
      if (!result.cacheInvalidated) throw new Error("PUBLICATION_CACHE_INVALIDATION_UNCONFIRMED");
      result.revalidationTriggered = Boolean(NEXT_REVALIDATE_URL && NEXT_REVALIDATE_SECRET);
      await PublicWebsiteCacheRevalidation.deliver(payload);
      return { ...result, delivered: true, revalidationDelivered: true, revalidationQueued: false,
        state: "draft", reason: "WEBSITE_REMOVED", checkedAt: new Date().toISOString() };
    }
    if (payload.delivery && payload.delivery.adminId !== website.adminId) throw new Error("PUBLICATION_TENANT_MISMATCH");
    result.revision = website.publishedRevisionNumber;
    result.publicUrl = WEBSITE_BASE_DOMAIN ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}` : null;
    // Order is a correctness boundary: no host/projection fill may observe the
    // cached pre-publication DRAFT or pre-suspension authorization decision.
    result.accessInvalidated = await TenantAccessResolver.invalidate(website.adminId);
    if (!result.accessInvalidated) throw new Error("TENANT_ACCESS_INVALIDATION_UNCONFIRMED");
    const [labels, hosts, projection] = await Promise.all([
      WebsiteHostResolverService.invalidateSubdomains([website.subdomain, ...website.subdomainAliases.map(a => a.subdomain)]),
      WebsiteHostResolverService.invalidateHosts(website.domains.map(d => d.domain)),
      WebsiteProjectionCacheService.invalidateWebsite(website.id, website.adminId, { revalidateNext: false, reason: payload.reason }),
    ]);
    result.routingInvalidated = labels === true && hosts === true;
    result.projectionInvalidated = projection.invalidated;
    result.cacheInvalidated = result.accessInvalidated && result.routingInvalidated && result.projectionInvalidated;
    if (!result.cacheInvalidated) throw new Error("PUBLICATION_CACHE_INVALIDATION_UNCONFIRMED");

    const access = await TenantAccessResolver.resolve(website.adminId);
    result.validUntil = access.validUntil;
    const publicAllowed = website.status === "PUBLISHED" && access.access.publicWebsiteAllowed;
    // Purge Next only after server caches are invalidated. Failed delivery keeps
    // this SAME durable event pending; it never queues a second callback row.
    result.revalidationTriggered = Boolean(NEXT_REVALIDATE_URL && NEXT_REVALIDATE_SECRET);
    await traceAsyncOperation("external", "frontend.cache-revalidation.publication", () => PublicWebsiteCacheRevalidation.deliver({
      ...payload, tenantIdentifier: website.subdomain,
      tenantIdentifiers: [...new Set([...(payload.tenantIdentifiers ?? []), website.subdomain,
        ...website.subdomainAliases.map(a => a.subdomain), ...website.domains.map(d => d.domain)])],
    }));
    result.revalidationDelivered = true;
    if (publicAllowed) {
      const verified = await traceAsyncOperation("custom", "website.publication.verify", () => verify(website));
      Object.assign(result, verified, { canonicalHostVerified: true, projectionRevisionVerified: true });
      if (!verified.projectionWarmed) throw new Error("PUBLICATION_WARMING_UNCONFIRMED");
      result.ready = true;
      result.state = "live";
    } else {
      result.state = website.status === "PUBLISHED" || website.status === "SUSPENDED" ? "temporarily_unavailable" : "draft";
      result.reason = access.website.deniedReason;
    }
    result.delivered = true;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : "PUBLICATION_DELIVERY_FAILED";
    logger.warn("website_publication_delivery_incomplete", {
      ...getTracePropagationMetadata(), websiteId: payload.websiteId, revision: result.revision, reason: result.reason,
    });
  }
  result.checkedAt = new Date().toISOString();
  result.revalidationQueued = !result.delivered;
  return result;
};

/** The event pointer is changed inside the lifecycle transaction. An older
 * worker/request can never acknowledge a newer publication or restoration.
 * Keeping the receipt on the website also survives ordinary outbox retention.
 */
const recordReceipt = async (eventId: string, websiteId: string, outcome: WebsitePublicationDelivery, db: Pick<Prisma.TransactionClient, "businessWebsite"> = prisma) => {
  return db.businessWebsite.updateMany({
    where: { id: websiteId, publicationDeliveryEventId: eventId, publishedRevisionNumber: outcome.revision },
    data: { publicationDeliveryReceipt: JSON.parse(JSON.stringify(outcome)) as Prisma.InputJsonValue },
  });
};

/** CAS receipt update: never steal a row already leased by the outbox worker. */
const attemptImmediate = async (event: { id: string; payload: unknown }): Promise<WebsitePublicationDelivery> => {
  const payload = parsePublicWebsiteCacheInvalidationPayload(event.payload);
  const outcome = await deliver(payload);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const updated = await tx.outboxEvent.updateMany({
      where: { id: event.id, status: { in: ["PENDING", "RETRY", "DEAD", "PROCESSED"] } },
      data: {
        status: outcome.delivered ? "PROCESSED" : "RETRY",
        processedAt: outcome.delivered ? new Date() : null,
        lockedAt: null, lastError: outcome.delivered ? null : outcome.reason,
        ...(outcome.delivered ? {} : { attempts: 0, nextAttemptAt: new Date(Date.now() + 5_000) }),
        payload: { ...(event.payload as Prisma.InputJsonObject), receipt: JSON.parse(JSON.stringify(outcome)) as Prisma.InputJsonValue },
      },
    });
      // Persist both receipts atomically. A failed website write must not leave
      // a PROCESSED event with no recoverable compact readiness receipt.
      if (updated.count === 1) await recordReceipt(event.id, payload.websiteId, outcome, tx);
      return updated;
    });
    outcome.revalidationQueued = !outcome.delivered || updated.count !== 1;
  } catch {
    // COMMIT succeeded and the original row is already durable. A response may
    // truthfully report ready plus retry queued when receipt persistence failed.
    outcome.revalidationQueued = true;
  }
  return outcome;
};

const bindToRevision = (delivery: WebsitePublicationDelivery, revision: number | null): WebsitePublicationDelivery =>
  delivery.revision === revision ? delivery : {
    ...delivery, ready: false, state: "preparing", reason: "PUBLICATION_CHANGED_DURING_DELIVERY",
  };

const compactStatus = (organizationId: string, websiteId: string, publishedRevisionNumber: number | null, delivery: WebsitePublicationDelivery) => {
  const ready = delivery.ready && delivery.revision === publishedRevisionNumber &&
    delivery.projectionWarmed && delivery.canonicalHostVerified && delivery.projectionRevisionVerified &&
    Number.isFinite(Date.parse(delivery.validUntil ?? "")) && Date.parse(delivery.validUntil!) > Date.now();
  return {
    organizationId, websiteId, publishedRevisionNumber,
    state: delivery.state === "live" && !ready ? "preparing" as const : delivery.state,
    publicUrl: delivery.publicUrl, ready,
    verifiedRevisionNumber: delivery.projectionRevisionVerified ? delivery.revision : null,
    checkedAt: delivery.checkedAt, validUntil: delivery.validUntil,
    reason: delivery.reason, retryAfterMs: delivery.state === "preparing" || !ready ? 5_000 : 30_000,
  };
};

/** Compact, authenticated, no-store read model. A persisted proof belongs to
 * the latest durable lifecycle event and the immutable publication revision.
 * Only the delivery path loads/warms the full projection; a header poll must
 * never load snapshots, history, pages, assets, or analytics aggregates.
 */
const getStatus = async (adminId: string) => {
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: {
    id: true, status: true, subdomain: true, publishedRevisionNumber: true,
    publicationDeliveryEventId: true, publicationDeliveryReceipt: true,
  } });
  if (!website) return null;
  const outcome = emptyOutcome();
  outcome.revision = website.publishedRevisionNumber;
  outcome.publicUrl = WEBSITE_BASE_DOMAIN ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}` : null;
  if (website.status !== "PUBLISHED") {
    outcome.state = website.status === "SUSPENDED" ? "temporarily_unavailable" : "draft";
    return compactStatus(adminId, website.id, website.publishedRevisionNumber, outcome);
  }
  try {
    const access = await TenantAccessResolver.resolve(adminId);
    outcome.validUntil = access.validUntil;
    if (!access.access.publicWebsiteAllowed) {
      outcome.state = "temporarily_unavailable"; outcome.reason = access.website.deniedReason;
    } else {
      const receipt = website.publicationDeliveryReceipt as Partial<WebsitePublicationDelivery> | null;
      const proof = website.publicationDeliveryEventId && receipt?.delivered === true && receipt.ready === true &&
        receipt.revision === website.publishedRevisionNumber && receipt.projectionWarmed === true &&
        receipt.projectionRevisionVerified === true && receipt.revalidationDelivered === true;
      if (!proof) {
        outcome.state = receipt?.state === "temporarily_unavailable" ? "temporarily_unavailable" : "preparing";
        outcome.reason = "PUBLICATION_DELIVERY_PENDING";
      } else {
        if (!WEBSITE_BASE_DOMAIN) throw new Error("WEBSITE_BASE_DOMAIN_NOT_CONFIGURED");
        const platform = await WebsiteHostResolverService.resolveHost(`${website.subdomain}.${WEBSITE_BASE_DOMAIN}`);
        const canonical = platform.isAlias
          ? await WebsiteHostResolverService.resolveHost(platform.canonicalHost) : platform;
        if (platform.websiteId !== website.id || canonical.websiteId !== website.id ||
            canonical.availability !== "live" || canonical.isAlias ||
            platform.publishedRevisionNumber !== website.publishedRevisionNumber ||
            canonical.publishedRevisionNumber !== website.publishedRevisionNumber) throw new Error("CANONICAL_HOST_NOT_READY");
        // A lifecycle change may commit while the routing read is in flight.
        const current = await prisma.businessWebsite.findUnique({ where: { id: website.id }, select: {
          status: true, publishedRevisionNumber: true, publicationDeliveryEventId: true,
        } });
        if (current?.status !== "PUBLISHED" || current.publishedRevisionNumber !== website.publishedRevisionNumber ||
            current.publicationDeliveryEventId !== website.publicationDeliveryEventId ||
            !await TenantAccessResolver.isCurrentGeneration(adminId, canonical.accessGeneration)) {
          throw new Error("PUBLICATION_CHANGED_DURING_STATUS");
        }
        Object.assign(outcome, { publicUrl: `https://${canonical.canonicalHost}`, ready: true, state: "live",
          // These attest to the delivered immutable revision, not a Redis ping.
          projectionWarmed: true, projectionRevisionVerified: true, canonicalHostVerified: true,
          validUntil: new Date(Math.min(Date.now() + 30_000, Date.parse(access.validUntil), Date.parse(platform.validUntil), Date.parse(canonical.validUntil))).toISOString(),
        });
      }
    }
  } catch {
    outcome.state = "temporarily_unavailable"; outcome.reason = "PUBLICATION_READINESS_UNAVAILABLE";
  }
  outcome.checkedAt = new Date().toISOString();
  return compactStatus(adminId, website.id, website.publishedRevisionNumber, outcome);
};

export const WebsitePublicationDeliveryService = { deliver, attemptImmediate, recordReceipt, bindToRevision, compactStatus, getStatus };
