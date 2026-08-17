import { createHmac } from "node:crypto";
import { subDays } from "date-fns";
import { ANALYTICS_HASH_SECRET, BETTER_AUTH_SECRET, WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { PublicWebsiteService } from "./publicWebsite.service";

export const WEBSITE_ANALYTICS_EVENT = {
  PAGE_VIEW: "PAGE_VIEW",
  CONTACT_SUBMITTED: "CONTACT_SUBMITTED",
  BOOKING_REQUEST: "BOOKING_REQUEST",
  ESTIMATE_REQUEST: "ESTIMATE_REQUEST",
} as const;

export type WebsiteAnalyticsEventType =
  (typeof WEBSITE_ANALYTICS_EVENT)[keyof typeof WEBSITE_ANALYTICS_EVENT];

export interface PublicAnalyticsPayload {
  eventType: "PAGE_VIEW";
  path: string;
  sessionId?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalyticsRequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface WebsiteAnalyticsSummary {
  days: number;
  range: { from: string; to: string };
  pageViews: number;
  uniqueVisitors: number;
  conversions: {
    contacts: number;
    bookings: number;
    estimates: number;
    total: number;
    rate: number;
  };
  topPages: Array<{ path: string; views: number }>;
  topServices: Array<{
    serviceCatalogId: string | null;
    name: string;
    requests: number;
    bookings: number;
    estimates: number;
  }>;
  referrers: Array<{ host: string; visits: number }>;
  devices: Array<{ type: "desktop" | "mobile" | "tablet" | "other"; visits: number; percentage: number }>;
}

const hashSecret = ANALYTICS_HASH_SECRET || BETTER_AUTH_SECRET || "analytics-development-only";
const SUMMARY_CACHE_VERSION = 1 as const;
const SUMMARY_CACHE_PREFIX = `website-analytics-summary:v${SUMMARY_CACHE_VERSION}:`;
const SUMMARY_CACHE_TTL_SECONDS = 45;

const normalizeDays = (requestedDays: number) => Math.min(Math.max(Math.trunc(requestedDays) || 30, 1), 730);

const sanitizePath = (value: string | null | undefined): string => {
  const raw = (value || "/").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw.split("#", 1)[0]!.slice(0, 500) || "/";
};

const safeReferrerHost = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "").slice(0, 253) || null;
  } catch {
    return null;
  }
};

const hash = (purpose: string, value: string): string =>
  createHmac("sha256", hashSecret).update(`${purpose}:${value}`).digest("hex");

const visitorHash = (ip: string | null | undefined): string | null => {
  if (!ip) return null;
  // Rotate the pseudonymous IP hash daily. Longer-range visitor counts prefer
  // the per-session hash and use this only as a privacy-safe fallback when
  // browser storage is unavailable.
  const day = new Date().toISOString().slice(0, 10);
  return hash(`visitor:${day}`, ip).slice(0, 40);
};

const sessionHash = (sessionId: string | null | undefined): string | null => {
  const normalized = sessionId?.trim();
  if (!normalized) return null;
  return hash("session", normalized.slice(0, 160)).slice(0, 40);
};

const deviceType = (userAgent: string | null | undefined): string | null => {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (/bot|crawler|spider|slurp|bingpreview|facebookexternalhit|whatsapp/.test(ua)) return "bot";
  if (/ipad|tablet|kindle/.test(ua)) return "tablet";
  if (/mobi|iphone|android/.test(ua)) return "mobile";
  return "desktop";
};

const PUBLIC_PAGE_METADATA_KEYS = new Set(["viewportWidth", "locale"]);

const cleanMetadata = (
  metadata: Record<string, unknown> | undefined,
  allowedKeys?: ReadonlySet<string>,
) => {
  if (!metadata) return {};
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 12)) {
    if (!/^[a-zA-Z0-9_.-]{1,50}$/.test(key)) continue;
    if (allowedKeys && !allowedKeys.has(key)) continue;
    if (typeof value === "string") result[key] = value.slice(0, 200);
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean" || value === null) result[key] = value;
  }
  return result;
};

const summaryCacheKey = (websiteId: string, days: number) => `${SUMMARY_CACHE_PREFIX}${websiteId}:${days}`;

const getCachedSummary = async (websiteId: string, days: number): Promise<WebsiteAnalyticsSummary | null> => {
  try {
    const raw = await redis.get(summaryCacheKey(websiteId, days));
    if (!raw) return null;
    return JSON.parse(raw) as WebsiteAnalyticsSummary;
  } catch {
    return null;
  }
};

const setCachedSummary = async (websiteId: string, days: number, summary: WebsiteAnalyticsSummary): Promise<void> => {
  try {
    // Small jitter prevents many tenants opened at the same time from
    // refreshing expensive aggregates in the same second.
    const ttl = SUMMARY_CACHE_TTL_SECONDS + Math.floor(Math.random() * 16);
    await redis.set(summaryCacheKey(websiteId, days), JSON.stringify(summary), "EX", ttl);
  } catch {
    // Analytics remain available from PostgreSQL during Redis outages.
  }
};

const createEvent = async (
  websiteId: string,
  eventType: WebsiteAnalyticsEventType,
  path: string,
  payload: Partial<PublicAnalyticsPayload> = {},
  context: AnalyticsRequestContext = {},
) => {
  const coarseDevice = deviceType(context.userAgent);
  if (coarseDevice === "bot") return { accepted: true, recorded: false };

  await prisma.websiteAnalyticsEvent.create({
    data: {
      websiteId,
      eventType,
      path: sanitizePath(path),
      visitorHash: visitorHash(context.ip),
      sessionHash: sessionHash(payload.sessionId),
      referrerHost: safeReferrerHost(payload.referrer),
      utmSource: payload.utmSource?.trim().slice(0, 120) || null,
      utmMedium: payload.utmMedium?.trim().slice(0, 120) || null,
      utmCampaign: payload.utmCampaign?.trim().slice(0, 160) || null,
      deviceType: coarseDevice,
      metadata: cleanMetadata(
        payload.metadata,
        eventType === WEBSITE_ANALYTICS_EVENT.PAGE_VIEW ? PUBLIC_PAGE_METADATA_KEYS : undefined,
      ) as any,
    },
  });
  return { accepted: true, recorded: true };
};

const trackPublicPageView = async (
  identifier: string,
  payload: PublicAnalyticsPayload,
  context: AnalyticsRequestContext,
) => {
  const resolved = await PublicWebsiteService.resolveIdentifier(identifier);
  // Resolve the public projection first so analytics cannot be written for a
  // suspended/unpublished tenant simply by guessing a valid subdomain. Only
  // real enabled website page paths are accepted, preventing unbounded path
  // cardinality from fabricated telemetry requests.
  const site = await PublicWebsiteService.getPublicWebsiteById(resolved.websiteId);
  const path = sanitizePath(payload.path);
  if (!site.pages.some((page) => page.path === path)) {
    return { accepted: true, recorded: false };
  }
  return createEvent(resolved.websiteId, WEBSITE_ANALYTICS_EVENT.PAGE_VIEW, path, payload, context);
};

const trackConversion = async (
  websiteId: string,
  eventType: Exclude<WebsiteAnalyticsEventType, "PAGE_VIEW">,
  path: string,
  metadata: Record<string, unknown> = {},
  campaign: Pick<PublicAnalyticsPayload, "utmSource" | "utmMedium" | "utmCampaign"> = {},
) => createEvent(websiteId, eventType, path, { metadata, ...campaign }, {});

interface VisitorCountRow { count: bigint }
interface ReferrerRow { host: string | null; visits: bigint }
interface DeviceRow { type: string | null; visits: bigint }
interface TopServiceRow {
  serviceCatalogId: string | null;
  name: string | null;
  requests: bigint;
  bookings: bigint;
  estimates: bigint;
}

const loadSummary = async (
  websiteId: string,
  ownHosts: ReadonlySet<string>,
  days: number,
): Promise<WebsiteAnalyticsSummary> => {
  const now = new Date();
  const since = subDays(now, days - 1);
  since.setHours(0, 0, 0, 0);
  const baseWhere = { websiteId, createdAt: { gte: since } };

  const [
    pageViews,
    visitorCountRows,
    contacts,
    bookings,
    estimates,
    pageGroups,
    referrerRows,
    deviceRows,
    topServiceRows,
  ] = await Promise.all([
    prisma.websiteAnalyticsEvent.count({
      where: { ...baseWhere, eventType: WEBSITE_ANALYTICS_EVENT.PAGE_VIEW },
    }),
    prisma.$queryRaw<VisitorCountRow[]>`
      SELECT COUNT(DISTINCT COALESCE("sessionHash", "visitorHash"))::bigint AS "count"
      FROM "website_analytics_event"
      WHERE "websiteId" = ${websiteId}
        AND "eventType" = ${WEBSITE_ANALYTICS_EVENT.PAGE_VIEW}
        AND COALESCE("sessionHash", "visitorHash") IS NOT NULL
        AND "createdAt" >= ${since}
    `,
    prisma.lead.count({
      where: { sourceWebsiteId: websiteId, createdAt: { gte: since } },
    }),
    prisma.bookingFormSubmission.count({
      where: { sourceWebsiteId: websiteId, createdAt: { gte: since } },
    }),
    prisma.estimateFormSubmission.count({
      where: { sourceWebsiteId: websiteId, createdAt: { gte: since } },
    }),
    prisma.websiteAnalyticsEvent.groupBy({
      by: ["path"],
      where: { ...baseWhere, eventType: WEBSITE_ANALYTICS_EVENT.PAGE_VIEW },
      _count: { _all: true },
    }),
    prisma.$queryRaw<ReferrerRow[]>`
      SELECT "referrerHost" AS "host",
             COUNT(DISTINCT COALESCE("sessionHash", "visitorHash"))::bigint AS "visits"
      FROM "website_analytics_event"
      WHERE "websiteId" = ${websiteId}
        AND "eventType" = ${WEBSITE_ANALYTICS_EVENT.PAGE_VIEW}
        AND COALESCE("sessionHash", "visitorHash") IS NOT NULL
        AND "createdAt" >= ${since}
      GROUP BY "referrerHost"
      ORDER BY "visits" DESC
      LIMIT 30
    `,
    prisma.$queryRaw<DeviceRow[]>`
      SELECT COALESCE("deviceType", 'other') AS "type",
             COUNT(DISTINCT COALESCE("sessionHash", "visitorHash"))::bigint AS "visits"
      FROM "website_analytics_event"
      WHERE "websiteId" = ${websiteId}
        AND "eventType" = ${WEBSITE_ANALYTICS_EVENT.PAGE_VIEW}
        AND COALESCE("sessionHash", "visitorHash") IS NOT NULL
        AND "createdAt" >= ${since}
      GROUP BY COALESCE("deviceType", 'other')
      ORDER BY "visits" DESC
    `,
    prisma.$queryRaw<TopServiceRow[]>`
      WITH "serviceActivity" AS (
        SELECT
          COALESCE("serviceCatalogId", 'legacy:' || COALESCE(NULLIF("serviceNameSnapshot", ''), 'Unknown service')) AS "activityKey",
          "serviceCatalogId" AS "serviceCatalogId",
          COALESCE(NULLIF("serviceNameSnapshot", ''), 'Unknown service') AS "snapshotName",
          'BOOKING'::text AS "kind"
        FROM "booking_form_submission"
        WHERE "sourceWebsiteId" = ${websiteId} AND "createdAt" >= ${since}
        UNION ALL
        SELECT
          COALESCE("serviceCatalogId", 'legacy:' || COALESCE(NULLIF("serviceNameSnapshot", ''), 'Unknown service')) AS "activityKey",
          "serviceCatalogId" AS "serviceCatalogId",
          COALESCE(NULLIF("serviceNameSnapshot", ''), 'Unknown service') AS "snapshotName",
          'ESTIMATE'::text AS "kind"
        FROM "estimate_form_submission"
        WHERE "sourceWebsiteId" = ${websiteId} AND "createdAt" >= ${since}
      )
      SELECT
        activity."serviceCatalogId" AS "serviceCatalogId",
        COALESCE(catalog."serviceName", MAX(activity."snapshotName")) AS "name",
        COUNT(*)::bigint AS "requests",
        COUNT(*) FILTER (WHERE activity."kind" = 'BOOKING')::bigint AS "bookings",
        COUNT(*) FILTER (WHERE activity."kind" = 'ESTIMATE')::bigint AS "estimates"
      FROM "serviceActivity" activity
      LEFT JOIN "service_catalog" catalog ON catalog."id" = activity."serviceCatalogId"
      GROUP BY activity."activityKey", activity."serviceCatalogId", catalog."serviceName"
      ORDER BY "requests" DESC, "name" ASC
      LIMIT 10
    `,
  ]);

  const uniqueVisitors = Number(visitorCountRows[0]?.count ?? 0);
  const totalConversions = contacts + bookings + estimates;
  const conversionRate = uniqueVisitors > 0 ? (totalConversions / uniqueVisitors) * 100 : 0;

  const devices = deviceRows.map((row) => {
    const normalized = row.type === "desktop" || row.type === "mobile" || row.type === "tablet" ? row.type : "other";
    const visits = Number(row.visits ?? 0);
    return {
      type: normalized,
      visits,
      percentage: uniqueVisitors > 0 ? (visits / uniqueVisitors) * 100 : 0,
    } as WebsiteAnalyticsSummary["devices"][number];
  });

  return {
    days,
    range: { from: since.toISOString(), to: now.toISOString() },
    pageViews,
    uniqueVisitors,
    conversions: {
      contacts,
      bookings,
      estimates,
      total: totalConversions,
      rate: conversionRate,
    },
    topPages: pageGroups
      .map((item) => ({ path: item.path, views: item._count._all }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10),
    topServices: topServiceRows.map((row) => ({
      serviceCatalogId: row.serviceCatalogId,
      name: row.name?.trim() || "Unknown service",
      requests: Number(row.requests ?? 0),
      bookings: Number(row.bookings ?? 0),
      estimates: Number(row.estimates ?? 0),
    })),
    referrers: referrerRows
      .filter((row) => !row.host || !ownHosts.has(row.host.toLowerCase()))
      .map((row) => ({ host: row.host?.trim() || "Direct", visits: Number(row.visits ?? 0) }))
      .filter((row) => row.visits > 0)
      .slice(0, 10),
    devices,
  };
};


const emptySummary = (days: number): WebsiteAnalyticsSummary => ({
  days,
  range: {
    from: subDays(new Date(), days - 1).toISOString(),
    to: new Date().toISOString(),
  },
  pageViews: 0,
  uniqueVisitors: 0,
  conversions: { contacts: 0, bookings: 0, estimates: 0, total: 0, rate: 0 },
  topPages: [],
  topServices: [],
  referrers: [],
  devices: [],
});

const getSummary = async (user: IRequestUser, requestedDays = 30): Promise<WebsiteAnalyticsSummary> => {
  const adminId = await getAdminId(user);
  const days = normalizeDays(requestedDays);
  const website = await prisma.businessWebsite.findUnique({
    where: { adminId },
    select: {
      id: true,
      subdomain: true,
      domains: { select: { domain: true } },
    },
  });
  if (!website) return emptySummary(days);

  const cached = await getCachedSummary(website.id, days);
  if (cached) return cached;

  const ownHosts = new Set<string>(website.domains.map((domain) => domain.domain.toLowerCase()));
  if (WEBSITE_BASE_DOMAIN) ownHosts.add(`${website.subdomain}.${WEBSITE_BASE_DOMAIN}`.toLowerCase());

  const summary = await loadSummary(website.id, ownHosts, days);
  void setCachedSummary(website.id, days, summary);
  return summary;
};

export const WebsiteAnalyticsService = {
  trackPublicPageView,
  trackConversion,
  getSummary,
};
