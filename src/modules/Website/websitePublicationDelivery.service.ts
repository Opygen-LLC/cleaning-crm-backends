import { WEBSITE_BASE_DOMAIN, NEXT_REVALIDATE_URL, NEXT_REVALIDATE_SECRET } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import logger from "../../lib/logger";
import { getTracePropagationMetadata, traceAsyncOperation } from "../../lib/monitoring/requestTrace";
import {
  PublicWebsiteCacheOutbox,
  PublicWebsiteCacheRevalidation,
  type PublicWebsiteCacheInvalidationPayload,
} from "../../lib/outbox/publicWebsiteCacheOutbox";
import { TenantAccessResolver } from "../Entitlement/tenantAccessResolver.service";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";
import { WebsiteProjectionCacheService } from "./websiteProjectionCache.service";
import { PublicWebsiteService } from "./publicWebsite.service";

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
  servedRevisionNumber: number | null;
  canonicalUrl: string | null;
  validUntil: string | null;
  ready: boolean;
  state: "live" | "preparing" | "temporarily_unavailable";
  /** Worker completion also covers a now-suspended/unpublished/deleted site. */
  completed: boolean;
  errors: string[];
}

type RevisionProjection = { website: { id: string; publishedRevisionNumber: number | null; canonicalUrl?: string | null } };

/**
 * Used by both the synchronous launch/publish path and the EXISTING outbox
 * worker. A retry always reads today's identity/revision; old events can never
 * resurrect a suspended website or overwrite a newer publication.
 */
const deliver = async (payload: PublicWebsiteCacheInvalidationPayload): Promise<WebsitePublicationDelivery> => {
  const result: WebsitePublicationDelivery = {
    cacheInvalidated: false, accessInvalidated: false, routingInvalidated: false,
    projectionInvalidated: false, revalidationTriggered: false,
    revalidationDelivered: false, revalidationQueued: false, projectionWarmed: false,
    canonicalHostVerified: false, servedRevisionNumber: null, canonicalUrl: null, validUntil: null, ready: false, completed: false,
    state: "preparing", errors: [],
  };
  try {
    const website = await prisma.businessWebsite.findUnique({
      where: { id: payload.websiteId },
      select: {
        id: true, adminId: true, status: true, subdomain: true, publishedRevisionNumber: true,
        subdomainAliases: { select: { subdomain: true } }, domains: { select: { domain: true } },
      },
    });
    const adminId = website?.adminId ?? payload.publication?.adminId ?? payload.accessChange?.adminId;
    if (!adminId) throw new Error("Publication delivery has no tenant identity");
    if (website && (payload.publication?.adminId ?? payload.accessChange?.adminId) && website.adminId !== (payload.publication?.adminId ?? payload.accessChange?.adminId)) {
      throw new Error("Publication delivery tenant identity mismatch");
    }

    // This MUST finish before any dependent cache is rebuilt or Next is told
    // to refetch. Its epoch blocks pre-commit DRAFT lookups from repopulating.
    result.accessInvalidated = await TenantAccessResolver.invalidate(adminId);
    const labels = [...new Set([
      payload.tenantIdentifier ?? "", ...(payload.tenantIdentifiers ?? []),
      website?.subdomain ?? "", ...(website?.subdomainAliases.map((alias) => alias.subdomain) ?? []),
    ].filter((label) => label && !label.includes(".")))];
    const hosts = [...new Set([
      ...(payload.tenantIdentifiers ?? []).filter((value) => value.includes(".")),
      ...(website?.domains.map((domain) => domain.domain) ?? []),
    ])];
    const [subdomains, customHosts, projection] = await Promise.all([
      WebsiteHostResolverService.invalidateSubdomains(labels),
      WebsiteHostResolverService.invalidateHosts(hosts),
      WebsiteProjectionCacheService.invalidateWebsite(payload.websiteId, adminId, { revalidateNext: false, reason: payload.reason }),
    ]);
    result.routingInvalidated = subdomains === true && customHosts === true;
    result.projectionInvalidated = projection.projectionInvalidated;
    result.cacheInvalidated = result.accessInvalidated && result.routingInvalidated && result.projectionInvalidated;
    if (!result.cacheInvalidated) throw new Error("PUBLICATION_CACHE_INVALIDATION_INCOMPLETE");

    // No second enqueue here: the durable receipt already exists at commit.
    result.revalidationTriggered = Boolean(NEXT_REVALIDATE_URL && NEXT_REVALIDATE_SECRET);
    await traceAsyncOperation("external", "frontend.cache-revalidation.publication", () =>
      PublicWebsiteCacheRevalidation.deliver({
        ...payload, tenantIdentifier: website?.subdomain ?? payload.tenantIdentifier,
        tenantIdentifiers: [...new Set([...labels, ...hosts])],
      }),
    );
    result.revalidationDelivered = true;
    if (!website || website.status !== "PUBLISHED") {
      result.state = "temporarily_unavailable";
      result.completed = true;
      return result;
    }
    const access = await TenantAccessResolver.resolve(adminId);
    if (!access.access.publicWebsiteAllowed) {
      result.state = "temporarily_unavailable";
      result.completed = true;
      return result;
    }
    if (!WEBSITE_BASE_DOMAIN || website.publishedRevisionNumber === null) {
      throw new Error("PUBLICATION_IDENTITY_OR_REVISION_MISSING");
    }
    const platformHost = `${website.subdomain}.${WEBSITE_BASE_DOMAIN}`;
    const route = await WebsiteHostResolverService.resolveHost(platformHost);
    if (route.websiteId !== website.id || route.availability !== "live") {
      throw new Error("PUBLICATION_PLATFORM_HOST_MISMATCH");
    }
    if (route.canonicalHost !== platformHost) {
      const canonical = await WebsiteHostResolverService.resolveHost(route.canonicalHost);
      if (canonical.websiteId !== website.id || canonical.availability !== "live") {
        throw new Error("PUBLICATION_CANONICAL_HOST_MISMATCH");
      }
    }
    result.canonicalHostVerified = true;
    result.canonicalUrl = `https://${route.canonicalHost}`;
    const served = await PublicWebsiteService.getPublicWebsiteById(website.id);
    const warmed = await WebsiteProjectionCacheService.get<RevisionProjection>(website.id);
    result.servedRevisionNumber = served.website.publishedRevisionNumber;
    // A successful DB fallback is NOT a successful cache warm.
    result.projectionWarmed = Boolean(warmed && warmed.website.id === website.id &&
      warmed.website.publishedRevisionNumber === website.publishedRevisionNumber);
    if (!result.projectionWarmed || served.website.id !== website.id ||
        served.website.publishedRevisionNumber !== website.publishedRevisionNumber ||
        served.website.canonicalUrl !== `https://${route.canonicalHost}`) {
      throw new Error("PUBLICATION_PROJECTION_NOT_CONFIRMED");
    }
    const current = await prisma.businessWebsite.findUnique({
      where: { id: website.id }, select: { status: true, publishedRevisionNumber: true, subdomain: true },
    });
    if (!current || current.status !== "PUBLISHED" || current.subdomain !== website.subdomain ||
        current.publishedRevisionNumber !== website.publishedRevisionNumber) {
      throw new Error("PUBLICATION_CHANGED_DURING_DELIVERY");
    }
    // Authorization may have changed while the public projection was loading.
    // Never certify a pre-suspension/pre-expiry route after a fresh denial.
    const finalAccess = await TenantAccessResolver.resolve(adminId, { fresh: true });
    const deadline = Math.min(Date.parse(route.accessValidUntil), Date.parse(finalAccess.cache?.validUntil ?? ""));
    if (!finalAccess.access.publicWebsiteAllowed || finalAccess.cache?.generation !== route.accessGeneration ||
        !Number.isFinite(deadline) || deadline <= Date.now()) {
      throw new Error("PUBLICATION_AUTHORIZATION_CHANGED_DURING_DELIVERY");
    }
    result.validUntil = new Date(Math.min(Date.now() + 30_000, deadline)).toISOString();
    result.completed = true;
    // The worker may have delivered a newer revision than this old receipt.
    result.ready = !payload.publication || payload.publication.revisionNumber === current.publishedRevisionNumber;
    result.state = result.ready ? "live" : "preparing";
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "PUBLICATION_DELIVERY_FAILED");
    logger.warn("website_publication_delivery_pending", { websiteId: payload.websiteId, ...getTracePropagationMetadata(), ...result });
  }
  return result;
};

const deliverImmediate = async (eventId: string, payload: PublicWebsiteCacheInvalidationPayload) => {
  const result = await traceAsyncOperation("custom", "website.publication-readiness", () => deliver(payload));
  if (result.completed && await PublicWebsiteCacheOutbox.acknowledgePublication(eventId)) return result;
  result.revalidationQueued = await PublicWebsiteCacheOutbox.retainPublicationRetry(eventId);
  // The coherent completion/status contract requires a durable readiness receipt.
  result.ready = false;
  if (result.state === "live") result.state = "preparing";
  return result;
};

export const WebsitePublicationDeliveryService = { deliver, deliverImmediate };
