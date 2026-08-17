import { createHmac } from "node:crypto";
import { subDays } from "date-fns";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { ANALYTICS_HASH_SECRET, BETTER_AUTH_SECRET } from "../../config/ENV";
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

const hashSecret = ANALYTICS_HASH_SECRET || BETTER_AUTH_SECRET || "analytics-development-only";

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
  // Rotate the pseudonymous IP hash daily. This keeps unique-visitor metrics
  // useful without turning the analytics table into long-term IP tracking.
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
) => createEvent(websiteId, eventType, path, { metadata }, {});

const getSummary = async (user: IRequestUser, requestedDays = 30) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({
    where: { adminId },
    select: { id: true },
  });
  if (!website) {
    return {
      days: Math.min(Math.max(requestedDays, 1), 90),
      pageViews: 0,
      uniqueVisitors: 0,
      conversions: { contacts: 0, bookings: 0, estimates: 0, total: 0 },
      topPages: [],
    };
  }

  const days = Math.min(Math.max(Math.trunc(requestedDays) || 30, 1), 90);
  const since = subDays(new Date(), days - 1);
  since.setHours(0, 0, 0, 0);
  const baseWhere = { websiteId: website.id, createdAt: { gte: since } };

  const [pageViews, visitorCountRows, conversions, pageGroups] = await Promise.all([
    prisma.websiteAnalyticsEvent.count({
      where: { ...baseWhere, eventType: WEBSITE_ANALYTICS_EVENT.PAGE_VIEW },
    }),
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT "visitorHash")::bigint AS "count"
      FROM "website_analytics_event"
      WHERE "websiteId" = ${website.id}
        AND "eventType" = ${WEBSITE_ANALYTICS_EVENT.PAGE_VIEW}
        AND "visitorHash" IS NOT NULL
        AND "createdAt" >= ${since}
    `,
    prisma.websiteAnalyticsEvent.groupBy({
      by: ["eventType"],
      where: {
        ...baseWhere,
        eventType: {
          in: [
            WEBSITE_ANALYTICS_EVENT.CONTACT_SUBMITTED,
            WEBSITE_ANALYTICS_EVENT.BOOKING_REQUEST,
            WEBSITE_ANALYTICS_EVENT.ESTIMATE_REQUEST,
          ],
        },
      },
      _count: { _all: true },
    }),
    prisma.websiteAnalyticsEvent.groupBy({
      by: ["path"],
      where: { ...baseWhere, eventType: WEBSITE_ANALYTICS_EVENT.PAGE_VIEW },
      _count: { _all: true },
    }),
  ]);

  const conversionCount = (eventType: WebsiteAnalyticsEventType) =>
    conversions.find((item) => item.eventType === eventType)?._count._all ?? 0;
  const contacts = conversionCount(WEBSITE_ANALYTICS_EVENT.CONTACT_SUBMITTED);
  const bookings = conversionCount(WEBSITE_ANALYTICS_EVENT.BOOKING_REQUEST);
  const estimates = conversionCount(WEBSITE_ANALYTICS_EVENT.ESTIMATE_REQUEST);

  return {
    days,
    pageViews,
    uniqueVisitors: Number(visitorCountRows[0]?.count ?? 0),
    conversions: { contacts, bookings, estimates, total: contacts + bookings + estimates },
    topPages: pageGroups
      .map((item) => ({ path: item.path, views: item._count._all }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10),
  };
};

export const WebsiteAnalyticsService = {
  trackPublicPageView,
  trackConversion,
  getSummary,
};
