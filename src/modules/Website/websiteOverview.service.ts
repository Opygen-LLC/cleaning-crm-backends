import { startOfMonth, subDays } from "date-fns";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";
import { CacheNamespaces } from "../../lib/cache/cachePolicy";

export interface WebsiteOverviewSummary {
  days: number;
  uniqueVisitors: number;
  bookings: number;
  bookingsThisMonth: number;
  leads: number;
}

interface WebsiteOverviewRow {
  uniqueVisitors: bigint;
  bookings: bigint;
  bookingsThisMonth: bigint;
  leads: bigint;
}

const OVERVIEW_DAYS = 30;
const CACHE_TTL_SECONDS = 45;
const cacheKey = (adminId: string) => CacheNamespaces.websiteStudioOverview(adminId);

const getCached = async (adminId: string): Promise<WebsiteOverviewSummary | null> => {
  try {
    const raw = await redis.get(cacheKey(adminId));
    if (!raw) return null;
    return JSON.parse(raw) as WebsiteOverviewSummary;
  } catch {
    // Redis is an optimization only. Website Studio must remain available if
    // the cache is temporarily unavailable.
    return null;
  }
};

const setCached = async (adminId: string, summary: WebsiteOverviewSummary): Promise<void> => {
  try {
    // Jitter prevents many tenants that opened Studio together from refreshing
    // the aggregate at exactly the same instant.
    const ttl = CACHE_TTL_SECONDS + Math.floor(Math.random() * 16);
    await redis.set(cacheKey(adminId), JSON.stringify(summary), "EX", ttl);
  } catch {
    // PostgreSQL remains the source of truth during Redis outages.
  }
};

/**
 * Small read model for the Website Studio Overview tab.
 *
 * The full analytics report intentionally stays lazy because it performs
 * several grouped aggregations. Overview only needs three acquisition KPIs, so
 * this uses one PostgreSQL statement (plus a short shared Redis cache) instead
 * of loading the analytics report or issuing three independent count queries.
 */
const getForAdminId = async (adminId: string): Promise<WebsiteOverviewSummary> => {
  const cached = await getCached(adminId);
  if (cached) return cached;

  const since = subDays(new Date(), OVERVIEW_DAYS - 1);
  since.setHours(0, 0, 0, 0);

  const monthStart = startOfMonth(new Date());

  const rows = await prisma.$queryRaw<WebsiteOverviewRow[]>`
    SELECT
      COALESCE((
        SELECT COUNT(DISTINCT COALESCE(event."sessionHash", event."visitorHash"))
        FROM "website_analytics_event" AS event
        WHERE event."websiteId" = website.id
          AND event."eventType" = 'PAGE_VIEW'
          AND COALESCE(event."sessionHash", event."visitorHash") IS NOT NULL
          AND event."createdAt" >= ${since}
      ), 0)::bigint AS "uniqueVisitors",
      COALESCE((
        SELECT COUNT(*)
        FROM "booking_form_submission" AS booking
        WHERE booking."sourceWebsiteId" = website.id
          AND booking."createdAt" >= ${since}
      ), 0)::bigint AS "bookings",
      COALESCE((
        SELECT COUNT(*)
        FROM "booking_form_submission" AS booking_month
        WHERE booking_month."sourceWebsiteId" = website.id
          AND booking_month."createdAt" >= ${monthStart}
      ), 0)::bigint AS "bookingsThisMonth",
      COALESCE((
        SELECT COUNT(*)
        FROM "lead" AS lead
        WHERE lead."sourceWebsiteId" = website.id
          AND lead."createdAt" >= ${since}
      ), 0)::bigint AS "leads"
    FROM "business_website" AS website
    WHERE website."adminId" = ${adminId}
    LIMIT 1
  `;

  const row = rows[0];
  const summary: WebsiteOverviewSummary = {
    days: OVERVIEW_DAYS,
    uniqueVisitors: Number(row?.uniqueVisitors ?? 0n),
    bookings: Number(row?.bookings ?? 0n),
    bookingsThisMonth: Number(row?.bookingsThisMonth ?? row?.bookings ?? 0n),
    leads: Number(row?.leads ?? 0n),
  };

  await setCached(adminId, summary);
  return summary;
};

const invalidateForAdminId = async (adminId: string): Promise<void> => {
  await redis.del(cacheKey(adminId)).catch(() => 0);
};

export const WebsiteOverviewService = { getForAdminId, invalidateForAdminId };
