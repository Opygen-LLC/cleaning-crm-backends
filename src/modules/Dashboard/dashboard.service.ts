import { prisma } from "../../lib/prisma/prisma";
import {
  BookingStatus,
  JobStatus,
  InvoiceStatus,
  LeaveStatus,
  RecurringStatus,
} from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import redis from "../../config/redis";
import { createHash } from "node:crypto";
import { CacheNamespaces, CacheTtl, ttlForKey } from "../../lib/cache/cachePolicy";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { IRequestUser } from "../../types/requestUser.interface";
import { currencyPrefix } from "../../lib/utils/money";
import { serviceDisplayName } from "../../lib/utils/serviceIdentity";
import type { Prisma } from "../../generated/prisma/client";
import { CacheResource, getCacheResourceVersion } from "../../lib/cache/resourceCacheVersion";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const previousPeriod = (from: Date, to: Date) => {
  const ms = to.getTime() - from.getTime();
  return { gte: new Date(from.getTime() - ms), lte: new Date(from.getTime()) };
};

const pct = (current: number, previous: number) =>
  previous === 0 ? 0 : Math.round(((current - previous) / previous) * 100);

// ─── Formatting helpers ───────────────────────────────────────────────────────

const formatBookingStatus = (s: string) => {
  switch (s) {
    case BookingStatus.SCHEDULED:
    case "SCHEDULED":
      return "Scheduled";
    case BookingStatus.IN_PROGRESS:
    case "IN_PROGRESS":
      return "In Progress";
    case BookingStatus.COMPLETED:
    case "COMPLETED":
      return "Completed";
    case BookingStatus.CANCELLED:
    case "CANCELLED":
      return "Cancelled";
    default:
      return s;
  }
};

const mapStatusToEnum = (s?: string): BookingStatus | undefined => {
  if (!s || s.toLowerCase() === "all") return undefined;
  const upper = s.toUpperCase().replace(/\s+/g, "_");
  if (upper === "SCHEDULED") return BookingStatus.SCHEDULED;
  if (upper === "IN_PROGRESS") return BookingStatus.IN_PROGRESS;
  if (upper === "COMPLETED") return BookingStatus.COMPLETED;
  if (upper === "CANCELLED") return BookingStatus.CANCELLED;
  return undefined;
};

const formatServiceType = (t?: string | null) => {
  if (!t) return "Service";
  return t
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (l) => l.toUpperCase());
};

// ─── Admin Dashboard Overview ─────────────────────────────────────────────────

interface DashboardOverviewQuery {
  period?: string;
  status?: string;
  search?: string;
  limit?: string | number;
  includeRevenueInsight?: string | boolean;
}

/**
 * Overview stats calculate confirmed metrics only:
 * - Revenue: Paid Invoices ONLY (unconverted Estimates / Quotes / Drafts strictly excluded)
 * - Active Bookings: Scheduled & In-Progress Bookings ONLY
 * - Completed Jobs: Completed Jobs ONLY
 * - Total Clients: Registered Clients ONLY
 */
const getDashboardOverview = async (
  user: IRequestUser | string,
  query?: DashboardOverviewQuery,
) => {
  const adminId = typeof user === "string" ? user : await getAdminId(user);
  const period = query?.period ?? "30d";
  const statusEnum = mapStatusToEnum(query?.status);
  const search = query?.search?.trim();
  const takeLimit = Math.min(50, Math.max(1, Number(query?.limit) || 10));
  const includeRevenueInsight = query?.includeRevenueInsight !== false && query?.includeRevenueInsight !== "false";

  const filterHash = createHash("sha1")
    .update(JSON.stringify({ status: statusEnum ?? "all", search: search ?? "", limit: takeLimit, includeRevenueInsight }))
    .digest("hex")
    .slice(0, 12);
  const dashboardVersion = await getCacheResourceVersion(adminId, CacheResource.dashboard);
  const cacheKey = CacheNamespaces.dashboardSummary(adminId, `v${dashboardVersion}:${period}:${filterHash}`);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* rebuild corrupt cache */ }
  }

  const now = new Date();
  const days = period === "7d" ? 7 : period === "90d" ? 90 : period === "12m" ? 365 : 30;
  const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prev = previousPeriod(periodStart, now);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const bucketUnit: "day" | "month" = period === "90d" || period === "12m" ? "month" : "day";

  const recentBookingsWhere: Prisma.BookingWhereInput = {
    adminId,
    ...(statusEnum ? { status: statusEnum } : {}),
    ...(search ? { OR: [
      { bookingRef: { contains: search, mode: "insensitive" } },
      { client: { name: { contains: search, mode: "insensitive" } } },
      { address: { contains: search, mode: "insensitive" } },
    ] } : {}),
  };

  type SummaryRow = {
    currentRevenue: string | number | null;
    previousRevenue: string | number | null;
    activeBookingsCount: bigint | number;
    activeBookingsPrevCount: bigint | number;
    totalClientsCount: bigint | number;
    clientsPrevCount: bigint | number;
    jobsCompletedCount: bigint | number;
    jobsCompletedPrevCount: bigint | number;
    monthlyRecurringValue: string | number | null;
    currency: string | null;
    businessEmail: string | null;
  };
  type ChartRow = { bucket: Date; revenue: string | number | null; jobsCompleted: bigint | number; newClients: bigint | number };

  const [summaryRows, chartRows, recentBookingsRaw, topStaffRaw] = await Promise.all([
    prisma.$queryRaw<SummaryRow[]>`
      SELECT
        (SELECT COALESCE(SUM(i.total), 0) FROM "invoice" i
          WHERE i."adminId" = ${adminId} AND i.status = 'PAID' AND i."paidDate" BETWEEN ${periodStart} AND ${now}) AS "currentRevenue",
        (SELECT COALESCE(SUM(i.total), 0) FROM "invoice" i
          WHERE i."adminId" = ${adminId} AND i.status = 'PAID' AND i."paidDate" BETWEEN ${prev.gte} AND ${prev.lte}) AS "previousRevenue",
        (SELECT COUNT(*) FROM "booking" b
          WHERE b."adminId" = ${adminId} AND b.status IN ('SCHEDULED','IN_PROGRESS')) AS "activeBookingsCount",
        (SELECT COUNT(*) FROM "booking" b
          WHERE b."adminId" = ${adminId} AND b.status IN ('SCHEDULED','IN_PROGRESS') AND b."createdAt" < ${periodStart}) AS "activeBookingsPrevCount",
        (SELECT COUNT(*) FROM "client" c WHERE c."adminId" = ${adminId}) AS "totalClientsCount",
        (SELECT COUNT(*) FROM "client" c WHERE c."adminId" = ${adminId} AND c."createdAt" < ${periodStart}) AS "clientsPrevCount",
        (SELECT COUNT(*) FROM "job" j
          WHERE j."adminId" = ${adminId} AND j.status = 'COMPLETED' AND j."updatedAt" BETWEEN ${periodStart} AND ${now}) AS "jobsCompletedCount",
        (SELECT COUNT(*) FROM "job" j
          WHERE j."adminId" = ${adminId} AND j.status = 'COMPLETED' AND j."updatedAt" BETWEEN ${prev.gte} AND ${prev.lte}) AS "jobsCompletedPrevCount",
        (SELECT COALESCE(SUM(CASE
          WHEN rs.frequency = 'WEEKLY' THEN rs.total * 4
          WHEN rs.frequency = 'BIWEEKLY' THEN rs.total * 2
          ELSE rs.total END), 0)
          FROM "recurring_schedule" rs WHERE rs."adminId" = ${adminId} AND rs.status = 'ACTIVE') AS "monthlyRecurringValue",
        (SELECT ap.currency::text FROM "AdminProfile" ap WHERE ap.id = ${adminId} LIMIT 1) AS currency,
        (SELECT COALESCE(NULLIF(ap."businessEmail", ''), u.email)
           FROM "AdminProfile" ap
           JOIN "user" u ON u.id = ap."userId"
          WHERE ap.id = ${adminId}
          LIMIT 1) AS "businessEmail"
    `,
    includeRevenueInsight ? prisma.$queryRaw<ChartRow[]>`
      SELECT bucket,
             COALESCE(SUM(revenue), 0) AS revenue,
             COALESCE(SUM("jobsCompleted"), 0)::bigint AS "jobsCompleted",
             COALESCE(SUM("newClients"), 0)::bigint AS "newClients"
      FROM (
        SELECT date_trunc(${bucketUnit}, i."paidDate") AS bucket,
               SUM(i.total) AS revenue, 0::bigint AS "jobsCompleted", 0::bigint AS "newClients"
        FROM "invoice" i
        WHERE i."adminId" = ${adminId} AND i.status = 'PAID' AND i."paidDate" BETWEEN ${periodStart} AND ${now}
        GROUP BY 1
        UNION ALL
        SELECT date_trunc(${bucketUnit}, j."updatedAt") AS bucket,
               0::numeric AS revenue, COUNT(*)::bigint AS "jobsCompleted", 0::bigint AS "newClients"
        FROM "job" j
        WHERE j."adminId" = ${adminId} AND j.status = 'COMPLETED' AND j."updatedAt" BETWEEN ${periodStart} AND ${now}
        GROUP BY 1
        UNION ALL
        SELECT date_trunc(${bucketUnit}, c."createdAt") AS bucket,
               0::numeric AS revenue, 0::bigint AS "jobsCompleted", COUNT(*)::bigint AS "newClients"
        FROM "client" c
        WHERE c."adminId" = ${adminId} AND c."createdAt" BETWEEN ${periodStart} AND ${now}
        GROUP BY 1
      ) metrics
      GROUP BY bucket
      ORDER BY bucket
    ` : Promise.resolve([] as ChartRow[]),
    prisma.booking.findMany({
      where: recentBookingsWhere,
      orderBy: { createdAt: "desc" },
      take: takeLimit,
      include: {
        client: { select: { id: true, name: true, email: true } },
        serviceCatalog: { select: { serviceName: true } },
        staffAssignments: { include: { staff: { include: { user: { select: { name: true } } } } }, take: 1 },
      },
    }),
    prisma.$queryRaw<{
      userId: string; name: string; image: string | null; specialty: string[];
      jobCount: bigint; avgRating: number | null; reviewCount: bigint;
    }[]>`
      WITH job_counts AS (
        SELECT jsa."staffId", COUNT(j.id)::bigint AS "jobCount"
        FROM "job_staff_assignment" jsa
        JOIN "job" j ON j.id = jsa."jobId"
        WHERE j.status = 'COMPLETED' AND j."updatedAt" >= ${ninetyDaysAgo} AND j."adminId" = ${adminId}
        GROUP BY jsa."staffId"
      ), review_stats AS (
        SELECT r."staffId", AVG(r.rating)::float AS "avgRating", COUNT(*)::bigint AS "reviewCount"
        FROM "review" r
        WHERE r."adminId" = ${adminId} AND r.status = 'published' AND r."staffId" IS NOT NULL
        GROUP BY r."staffId"
      )
      SELECT u.id AS "userId", u.name, u.image, sp.specialty,
             COALESCE(jc."jobCount", 0)::bigint AS "jobCount",
             rs."avgRating", COALESCE(rs."reviewCount", 0)::bigint AS "reviewCount"
      FROM "StaffProfile" sp
      JOIN "user" u ON u.id = sp."userId"
      LEFT JOIN job_counts jc ON jc."staffId" = sp.id
      LEFT JOIN review_stats rs ON rs."staffId" = sp.id
      WHERE sp."adminId" = ${adminId}
      ORDER BY "jobCount" DESC, u.name ASC
      LIMIT 4
    `,
  ]);

  const summary = summaryRows[0] ?? {} as SummaryRow;
  const currentRevenue = Number(summary.currentRevenue ?? 0);
  const previousRevenue = Number(summary.previousRevenue ?? 0);
  const activeBookingsCount = Number(summary.activeBookingsCount ?? 0);
  const activeBookingsPrevCount = Number(summary.activeBookingsPrevCount ?? 0);
  const totalClientsCount = Number(summary.totalClientsCount ?? 0);
  const clientsPrevCount = Number(summary.clientsPrevCount ?? 0);
  const jobsCompletedCount = Number(summary.jobsCompletedCount ?? 0);
  const jobsCompletedPrevCount = Number(summary.jobsCompletedPrevCount ?? 0);
  const currency = summary.currency ?? "USD";

  const stats = [
    { label: "Total Revenue", value: currentRevenue, changePercent: pct(currentRevenue, previousRevenue), prefix: currencyPrefix(currency) },
    { label: "Active Bookings", value: activeBookingsCount, changePercent: pct(activeBookingsCount, activeBookingsPrevCount) },
    { label: "Total Clients", value: totalClientsCount, changePercent: pct(totalClientsCount, clientsPrevCount) },
    { label: "Jobs Completed", value: jobsCompletedCount, changePercent: pct(jobsCompletedCount, jobsCompletedPrevCount) },
  ];

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const revenueMap = new Map<string, { revenue: number; jobsCompleted: number; newClients: number }>();
  const putEmpty = (label: string) => revenueMap.set(label, { revenue: 0, jobsCompleted: 0, newClients: 0 });
  const dailyLabel = (d: Date) => period === "7d" ? DAYS[d.getDay()] : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const monthLabel = (d: Date) => MONTHS[d.getMonth()];

  if (period === "7d" || period === "30d") {
    const points = period === "7d" ? 7 : 30;
    for (let i = points - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i); putEmpty(dailyLabel(d));
    }
  } else {
    const points = period === "90d" ? 4 : 12;
    for (let i = points - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(1); d.setMonth(now.getMonth() - i); putEmpty(monthLabel(d));
    }
  }

  for (const row of chartRows) {
    if (!row.bucket) continue;
    const d = new Date(row.bucket);
    const label = bucketUnit === "month" ? monthLabel(d) : dailyLabel(d);
    const entry = revenueMap.get(label) ?? { revenue: 0, jobsCompleted: 0, newClients: 0 };
    entry.revenue += Number(row.revenue ?? 0);
    entry.jobsCompleted += Number(row.jobsCompleted ?? 0);
    entry.newClients += Number(row.newClients ?? 0);
    revenueMap.set(label, entry);
  }

  const revenueInsight = Array.from(revenueMap.entries()).map(([day, data]) => ({
    day, revenue: Math.round(data.revenue), jobsCompleted: data.jobsCompleted, newClients: data.newClients,
  }));

  const recentBookings = recentBookingsRaw.map((b) => ({
    id: b.id,
    bookingRef: b.bookingRef,
    clientName: b.client?.name ?? "Client",
    serviceType: serviceDisplayName(b),
    scheduledDate: b.scheduledDate ? new Date(b.scheduledDate).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "",
    address: b.address,
    assignedStaff: b.staffAssignments[0]?.staff?.user?.name ?? "Unassigned",
    status: formatBookingStatus(b.status),
    total: Number(b.total),
  }));

  const topStaff = topStaffRaw.map((s) => ({
    id: s.userId,
    name: s.name,
    avatar: s.image ?? undefined,
    jobsCompleted: Number(s.jobCount),
    speciality: s.specialty?.[0] ? formatServiceType(s.specialty[0]) : "General cleaning",
    rating: Number(s.reviewCount) > 0 && s.avgRating != null ? Number(Number(s.avgRating).toFixed(1)) : null,
    reviewCount: Number(s.reviewCount),
  }));

  const result = {
    currency,
    businessEmail: summary.businessEmail ?? null,
    stats,
    revenueInsight,
    recentBookings,
    topStaff,
    monthlyRecurringValue: Math.round(Number(summary.monthlyRecurringValue ?? 0)),
  };

  await redis.setex(cacheKey, ttlForKey(CacheTtl.dashboardSummary, cacheKey), JSON.stringify(result)).catch(() => {});
  return result;
};


const getDashboardRevenueInsight = async (
  user: IRequestUser | string,
  period = "30d",
) => {
  const adminId = typeof user === "string" ? user : await getAdminId(user);
  const safePeriod = ["7d", "30d", "90d", "12m"].includes(period) ? period : "30d";
  const dashboardVersion = await getCacheResourceVersion(adminId, CacheResource.dashboard);
  const cacheKey = `dashboard:revenue-insight:${adminId}:v${dashboardVersion}:${safePeriod}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* rebuild corrupt cache */ }
  }

  const now = new Date();
  const days = safePeriod === "7d" ? 7 : safePeriod === "90d" ? 90 : safePeriod === "12m" ? 365 : 30;
  const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const bucketUnit: "day" | "month" = safePeriod === "90d" || safePeriod === "12m" ? "month" : "day";
  type ChartRow = { bucket: Date; revenue: string | number | null; jobsCompleted: bigint | number; newClients: bigint | number };

  const chartRows = await prisma.$queryRaw<ChartRow[]>`
    SELECT bucket,
           COALESCE(SUM(revenue), 0) AS revenue,
           COALESCE(SUM("jobsCompleted"), 0)::bigint AS "jobsCompleted",
           COALESCE(SUM("newClients"), 0)::bigint AS "newClients"
    FROM (
      SELECT date_trunc(${bucketUnit}, i."paidDate") AS bucket,
             SUM(i.total) AS revenue, 0::bigint AS "jobsCompleted", 0::bigint AS "newClients"
      FROM "invoice" i
      WHERE i."adminId" = ${adminId} AND i.status = 'PAID' AND i."paidDate" BETWEEN ${periodStart} AND ${now}
      GROUP BY 1
      UNION ALL
      SELECT date_trunc(${bucketUnit}, j."updatedAt") AS bucket,
             0::numeric AS revenue, COUNT(*)::bigint AS "jobsCompleted", 0::bigint AS "newClients"
      FROM "job" j
      WHERE j."adminId" = ${adminId} AND j.status = 'COMPLETED' AND j."updatedAt" BETWEEN ${periodStart} AND ${now}
      GROUP BY 1
      UNION ALL
      SELECT date_trunc(${bucketUnit}, c."createdAt") AS bucket,
             0::numeric AS revenue, 0::bigint AS "jobsCompleted", COUNT(*)::bigint AS "newClients"
      FROM "client" c
      WHERE c."adminId" = ${adminId} AND c."createdAt" BETWEEN ${periodStart} AND ${now}
      GROUP BY 1
    ) metrics
    GROUP BY bucket
    ORDER BY bucket
  `;

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const revenueMap = new Map<string, { revenue: number; jobsCompleted: number; newClients: number }>();
  const putEmpty = (label: string) => revenueMap.set(label, { revenue: 0, jobsCompleted: 0, newClients: 0 });
  const dailyLabel = (d: Date) => safePeriod === "7d" ? DAYS[d.getDay()]! : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const monthLabel = (d: Date) => MONTHS[d.getMonth()]!;

  if (safePeriod === "7d" || safePeriod === "30d") {
    const points = safePeriod === "7d" ? 7 : 30;
    for (let i = points - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i); putEmpty(dailyLabel(d));
    }
  } else {
    const points = safePeriod === "90d" ? 4 : 12;
    for (let i = points - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(1); d.setMonth(now.getMonth() - i); putEmpty(monthLabel(d));
    }
  }

  for (const row of chartRows) {
    if (!row.bucket) continue;
    const d = new Date(row.bucket);
    const label = bucketUnit === "month" ? monthLabel(d) : dailyLabel(d);
    const entry = revenueMap.get(label) ?? { revenue: 0, jobsCompleted: 0, newClients: 0 };
    entry.revenue += Number(row.revenue ?? 0);
    entry.jobsCompleted += Number(row.jobsCompleted ?? 0);
    entry.newClients += Number(row.newClients ?? 0);
    revenueMap.set(label, entry);
  }

  const result = Array.from(revenueMap.entries()).map(([day, data]) => ({
    day,
    revenue: Math.round(data.revenue),
    jobsCompleted: data.jobsCompleted,
    newClients: data.newClients,
  }));
  await redis.setex(cacheKey, 300, JSON.stringify(result)).catch(() => {});
  return result;
};

// ─── Revenue Page ─────────────────────────────────────────────────────────────

type RevenuePeriod = "7d" | "30d" | "90d" | "12m";

const getRevenuePage = async (
  user: IRequestUser | string,
  period: RevenuePeriod,
) => {
  const adminId = typeof user === "string" ? user : await getAdminId(user);
  const dashboardVersion = await getCacheResourceVersion(adminId, CacheResource.dashboard);
  const revCacheKey = `dashboard:revenue:${adminId}:v${dashboardVersion}:${period}`;
  const revCached = await redis.get(revCacheKey).catch(() => null);
  if (revCached) {
    try { return JSON.parse(revCached); } catch { /* rebuild corrupt entry */ }
  }

  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  let from: Date;
  let bucketFn: (d: Date) => string;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  if (period === "7d") {
    from = new Date(now.getTime() - 7 * msPerDay);
    bucketFn = (d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]!;
  } else if (period === "30d") {
    from = new Date(now.getTime() - 30 * msPerDay);
    bucketFn = (d) => `Week ${Math.ceil(d.getDate() / 7)}`;
  } else if (period === "90d") {
    from = new Date(now.getTime() - 90 * msPerDay);
    bucketFn = (d) => monthNames[d.getMonth()]!;
  } else {
    from = new Date(now);
    from.setFullYear(from.getFullYear() - 1);
    bucketFn = (d) => monthNames[d.getMonth()]!;
  }

  const prev = previousPeriod(from, now);
  const bucketUnit: "day" | "month" = period === "90d" || period === "12m" ? "month" : "day";

  type RevenueAggregateRow = {
    currentRevenue: string | number | null;
    previousRevenue: string | number | null;
    currentExpenses: string | number | null;
    previousExpenses: string | number | null;
    outstanding: string | number | null;
    jobCountCurrent: bigint | number;
    currency: string | null;
    chartRows: unknown;
  };
  type ServiceRevenueRow = {
    serviceCatalogId: string | null;
    serviceName: string | null;
    revenue: string | number | null;
    jobs: bigint | number;
  };
  type RawChartRow = { bucket: string | Date; revenue: string | number | null; expenses: string | number | null };

  // Four database operations total on a cold revenue page:
  //  1) totals + current/previous comparisons + chart + currency + job count
  //  2) revenue-by-service joined directly to service_catalog
  //  3) recent invoices
  //  4) staff completed-job aggregate
  // This replaces the previous 12-way fan-out plus a 13th service-name lookup.
  const [aggregateRows, serviceRows, recentInv, staffWithJobsRaw] = await Promise.all([
    prisma.$queryRaw<RevenueAggregateRow[]>`
      WITH revenue_buckets AS (
        SELECT date_trunc(${bucketUnit}, i."paidDate") AS bucket,
               COALESCE(SUM(i.total), 0) AS revenue
        FROM "invoice" i
        WHERE i."adminId" = ${adminId}
          AND i.status = 'PAID'
          AND i."paidDate" BETWEEN ${from} AND ${now}
        GROUP BY 1
      ),
      expense_buckets AS (
        SELECT date_trunc(${bucketUnit}, e.date) AS bucket,
               COALESCE(SUM(e.amount), 0) AS expenses
        FROM "expense" e
        WHERE e."adminId" = ${adminId}
          AND e.date BETWEEN ${from} AND ${now}
        GROUP BY 1
      ),
      chart AS (
        SELECT COALESCE(r.bucket, e.bucket) AS bucket,
               COALESCE(r.revenue, 0) AS revenue,
               COALESCE(e.expenses, 0) AS expenses
        FROM revenue_buckets r
        FULL OUTER JOIN expense_buckets e ON e.bucket = r.bucket
      )
      SELECT
        (SELECT COALESCE(SUM(i.total), 0) FROM "invoice" i
          WHERE i."adminId" = ${adminId} AND i.status = 'PAID' AND i."paidDate" BETWEEN ${from} AND ${now}) AS "currentRevenue",
        (SELECT COALESCE(SUM(i.total), 0) FROM "invoice" i
          WHERE i."adminId" = ${adminId} AND i.status = 'PAID' AND i."paidDate" BETWEEN ${prev.gte} AND ${prev.lte}) AS "previousRevenue",
        (SELECT COALESCE(SUM(e.amount), 0) FROM "expense" e
          WHERE e."adminId" = ${adminId} AND e.date BETWEEN ${from} AND ${now}) AS "currentExpenses",
        (SELECT COALESCE(SUM(e.amount), 0) FROM "expense" e
          WHERE e."adminId" = ${adminId} AND e.date BETWEEN ${prev.gte} AND ${prev.lte}) AS "previousExpenses",
        (SELECT COALESCE(SUM(i.total), 0) FROM "invoice" i
          WHERE i."adminId" = ${adminId} AND i.status IN ('SENT','OVERDUE')) AS outstanding,
        (SELECT COUNT(*) FROM "job" j
          WHERE j."adminId" = ${adminId} AND j.status = 'COMPLETED' AND j."updatedAt" BETWEEN ${from} AND ${now}) AS "jobCountCurrent",
        (SELECT ap.currency::text FROM "AdminProfile" ap WHERE ap.id = ${adminId} LIMIT 1) AS currency,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('bucket', c.bucket, 'revenue', c.revenue, 'expenses', c.expenses)
            ORDER BY c.bucket
          ) FROM chart c
        ), '[]'::jsonb) AS "chartRows"
    `,
    prisma.$queryRaw<ServiceRevenueRow[]>`
      SELECT i."serviceCatalogId",
             COALESCE(sc."serviceName", 'Other') AS "serviceName",
             COALESCE(SUM(i.total), 0) AS revenue,
             COUNT(*)::bigint AS jobs
      FROM "invoice" i
      LEFT JOIN "service_catalog" sc ON sc.id = i."serviceCatalogId"
      WHERE i."adminId" = ${adminId}
        AND i.status = 'PAID'
        AND i."paidDate" BETWEEN ${from} AND ${now}
      GROUP BY i."serviceCatalogId", sc."serviceName"
      ORDER BY revenue DESC
    `,
    prisma.invoice.findMany({
      where: { adminId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        invoiceRef: true,
        clientName: true,
        serviceCatalog: { select: { serviceName: true } },
        issuedDate: true,
        total: true,
        status: true,
      },
    }),
    prisma.$queryRaw<{ userId: string; name: string; image: string | null; jobCount: bigint }[]>`
      SELECT u.id AS "userId", u.name, u.image, COUNT(j.id)::bigint AS "jobCount"
      FROM "StaffProfile" sp
      JOIN "user" u ON u.id = sp."userId"
      LEFT JOIN "job_staff_assignment" jsa ON jsa."staffId" = sp.id
      LEFT JOIN "job" j ON j.id = jsa."jobId"
        AND j.status = 'COMPLETED'
        AND j."updatedAt" BETWEEN ${from} AND ${now}
      WHERE sp."adminId" = ${adminId}
      GROUP BY u.id, u.name, u.image
      ORDER BY "jobCount" DESC
    `,
  ]);

  const aggregate = aggregateRows[0];
  const totalRevenue = Number(aggregate?.currentRevenue ?? 0);
  const prevRevenue = Number(aggregate?.previousRevenue ?? 0);
  const totalExpenses = Number(aggregate?.currentExpenses ?? 0);
  const prevExpenses = Number(aggregate?.previousExpenses ?? 0);
  const totalProfit = totalRevenue - totalExpenses;
  const prevProfit = prevRevenue - prevExpenses;
  const outstanding = Number(aggregate?.outstanding ?? 0);
  const jobCountCurrent = Number(aggregate?.jobCountCurrent ?? 0);
  const revenueCurrency = aggregate?.currency ?? "USD";
  const revenuePrefix = currencyPrefix(revenueCurrency);

  const chartRows: RawChartRow[] = Array.isArray(aggregate?.chartRows)
    ? (aggregate!.chartRows as RawChartRow[])
    : [];
  const chart = chartRows.map((row) => {
    const revenue = Number(row.revenue ?? 0);
    const expenses = Number(row.expenses ?? 0);
    return {
      label: bucketFn(new Date(row.bucket)),
      revenue,
      expenses,
      profit: revenue - expenses,
    };
  });

  const byService = serviceRows.map((row) => {
    const revenue = Number(row.revenue ?? 0);
    const jobs = Number(row.jobs ?? 0);
    return {
      serviceType: row.serviceName ?? "Other",
      revenue,
      jobs,
      avgPerJob: jobs > 0 ? Math.round(revenue / jobs) : 0,
      changePercent: 0,
    };
  });

  const byStaff = staffWithJobsRaw
    .map((staff) => ({
      staffId: staff.userId,
      name: staff.name,
      avatar: staff.image ?? undefined,
      revenue: 0,
      jobs: Number(staff.jobCount),
      avgRating: 0,
    }))
    .sort((a, b) => b.jobs - a.jobs);

  const statusMap: Record<string, "Paid" | "Pending" | "Overdue"> = {
    PAID: "Paid",
    SENT: "Pending",
    OVERDUE: "Overdue",
    DRAFT: "Pending",
    CANCELLED: "Pending",
  };
  const recentTransactions = recentInv.map((inv) => ({
    id: inv.id,
    bookingRef: inv.invoiceRef,
    clientName: inv.clientName,
    serviceType: inv.serviceCatalog?.serviceName ?? "Other",
    date: inv.issuedDate.toISOString(),
    amount: Number(inv.total),
    status: statusMap[inv.status] ?? "Pending",
  }));

  const revenueResult = {
    currency: revenueCurrency,
    stats: {
      totalRevenue: { label: "Total Revenue", value: totalRevenue, changePercent: pct(totalRevenue, prevRevenue), prefix: revenuePrefix },
      totalProfit: { label: "Net Profit", value: totalProfit, changePercent: pct(totalProfit, prevProfit), prefix: revenuePrefix },
      avgJobValue: { label: "Avg. Job Value", value: jobCountCurrent > 0 ? Math.round(totalRevenue / jobCountCurrent) : 0, changePercent: 0, prefix: revenuePrefix },
      outstandingInvoices: { label: "Outstanding Invoices", value: outstanding, changePercent: 0, prefix: revenuePrefix },
    },
    chart,
    byService,
    byStaff,
    recentTransactions,
  };

  await redis.setex(revCacheKey, 300, JSON.stringify(revenueResult)).catch(() => {});
  return revenueResult;
};

// ─── Helpers shared by getStaffDashboard ──────────────────────────────────────

const requireStaffProfile = async (userId: string) => {
  const staff = await prisma.staffProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      adminId: true,
      hourlyRate: true,
      user: { select: { name: true, image: true } },
    },
  });
  if (!staff) {
    throw new AppError(status.NOT_FOUND, "Staff profile not found", {
      code: "STAFF_PROFILE_MISSING",
      retryable: false,
      kind: "TENANT_INVARIANT",
    });
  }
  return staff;
};

const formatDuration = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

const formatScheduledDate = (date: Date): string =>
  date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

const staffDashboardJobSelect = {
  job: {
    select: {
      id: true,
      jobRef: true,
      serviceType: true,
      address: true,
      scheduledDate: true,
      durationMins: true,
      status: true,
      notes: true,
      client: { select: { name: true, phone: true } },
    },
  },
} satisfies Prisma.JobStaffAssignmentSelect;

/**
 * Staff dashboard read model.
 *
 * This intentionally uses purpose-specific projections. The dashboard does not
 * need checklist rows, client email, staff-assignment graphs or full Job
 * records; checklist progress belongs on the job-detail surface. Weekly counts
 * and earnings are derived from one compact assignment query instead of five
 * independent count/findMany calls.
 */
const getStaffDashboard = async (userId: string) => {
  const staffProfile = await requireStaffProfile(userId);
  const staffId = staffProfile.id;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const prevWeekStart = new Date(weekStart);
  prevWeekStart.setDate(weekStart.getDate() - 7);
  const prevWeekEnd = new Date(weekStart);
  prevWeekEnd.setMilliseconds(-1);
  const upcomingEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  type StaffDashboardAggregateRow = {
    completedTotal: bigint | number;
    unreadCount: bigint | number;
    weekRating: number | null;
  };

  const [windowAssignments, recentAssignments, aggregateRows, leaveRecords] = await Promise.all([
    prisma.jobStaffAssignment.findMany({
      where: {
        staffId,
        job: {
          adminId: staffProfile.adminId,
          scheduledDate: { gte: todayStart, lte: upcomingEnd },
          status: { not: JobStatus.CANCELLED },
        },
      },
      select: staffDashboardJobSelect,
      orderBy: { job: { scheduledDate: "asc" } },
      take: 40,
    }),
    prisma.jobStaffAssignment.findMany({
      where: {
        staffId,
        OR: [
          { job: { adminId: staffProfile.adminId, scheduledDate: { gte: prevWeekStart, lte: now } } },
          { checkOutAt: { gte: weekStart, lte: now } },
          { job: { adminId: staffProfile.adminId, updatedAt: { gte: weekStart, lte: now } } },
        ],
      },
      select: {
        hoursWorked: true,
        checkOutAt: true,
        job: { select: { scheduledDate: true, status: true, updatedAt: true } },
      },
    }),
    prisma.$queryRaw<StaffDashboardAggregateRow[]>`
      SELECT
        (
          SELECT COUNT(*)::bigint
          FROM "job_staff_assignment" jsa
          JOIN "job" j ON j.id = jsa."jobId"
          WHERE jsa."staffId" = ${staffId}
            AND j."adminId" = ${staffProfile.adminId}
            AND j.status = 'COMPLETED'
        ) AS "completedTotal",
        (
          SELECT COUNT(*)::bigint
          FROM "notification" n
          WHERE n."adminId" = ${staffProfile.adminId}
            AND n."isRead" = false
            AND n."createdAt" >= ${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)}
        ) AS "unreadCount",
        (
          SELECT AVG(r.rating)::float8
          FROM "review" r
          WHERE r."staffId" = ${staffId}
            AND r."createdAt" BETWEEN ${weekStart} AND ${now}
        ) AS "weekRating"
    `,
    prisma.staffLeave.findMany({
      where: {
        staffId,
        status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
        endDate: { gte: todayStart },
      },
      select: { id: true, startDate: true, endDate: true, status: true },
      orderBy: { startDate: "asc" },
    }),
  ]);

  const todaysAssignments = windowAssignments.filter((assignment) =>
    assignment.job.scheduledDate >= todayStart && assignment.job.scheduledDate <= todayEnd,
  );
  const upcomingAssignments = windowAssignments
    .filter((assignment) => assignment.job.scheduledDate > todayEnd)
    .slice(0, 10);
  const aggregate = aggregateRows[0];
  const completedTotalCount = Number(aggregate?.completedTotal ?? 0);
  const unreadCount = Number(aggregate?.unreadCount ?? 0);
  const weekRating = Number(aggregate?.weekRating ?? 0);

  const inRange = (date: Date, from: Date, to: Date) => date >= from && date <= to;
  const weekJobsCount = recentAssignments.filter((a) =>
    inRange(a.job.scheduledDate, weekStart, now),
  ).length;
  const prevWeekJobsCount = recentAssignments.filter((a) =>
    inRange(a.job.scheduledDate, prevWeekStart, prevWeekEnd),
  ).length;
  const completedTodayCount = recentAssignments.filter(
    (a) => a.job.status === JobStatus.COMPLETED && inRange(a.job.updatedAt, todayStart, todayEnd),
  ).length;
  const weekCompletedCount = recentAssignments.filter(
    (a) => a.job.status === JobStatus.COMPLETED && inRange(a.job.updatedAt, weekStart, now),
  ).length;
  const hourlyRate = staffProfile.hourlyRate ?? 0;
  const weekEarnings = recentAssignments.reduce((sum, assignment) => {
    if (!assignment.checkOutAt || assignment.checkOutAt < weekStart || assignment.checkOutAt > now) return sum;
    return sum + Number(assignment.hoursWorked ?? 0) * hourlyRate;
  }, 0);

  const activeLeave =
    leaveRecords.find(
      (leave) =>
        leave.status === LeaveStatus.APPROVED &&
        leave.startDate <= now &&
        leave.endDate >= now,
    ) ?? null;
  const upcomingLeave = leaveRecords.find((leave) => leave.startDate > now) ?? null;

  const shapeJob = (assignment: (typeof todaysAssignments)[number]) => {
    const job = assignment.job;
    return {
      id: job.id,
      bookingRef: job.jobRef,
      clientName: job.client.name,
      clientPhone: job.client.phone ?? "",
      clientAvatar: undefined as string | undefined,
      serviceType: job.serviceType,
      address: job.address,
      scheduledDate: formatScheduledDate(job.scheduledDate),
      scheduledTime: job.scheduledDate.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }),
      duration: formatDuration(job.durationMins),
      status: job.status as string,
      notes: job.notes ?? undefined,
    };
  };

  const todaysJobs = todaysAssignments.map(shapeJob);
  const upcomingJobs = upcomingAssignments.map(shapeJob);
  const weekChangePct =
    prevWeekJobsCount === 0
      ? 0
      : Math.round(((weekJobsCount - prevWeekJobsCount) / prevWeekJobsCount) * 100);

  const staffName = staffProfile.user.name;
  const initials = staffName
    .split(" ")
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return {
    staffId,
    staffName,
    avatarInitials: initials,
    avatarUrl: staffProfile.user.image ?? undefined,
    stats: [
      { label: "Jobs today", value: todaysJobs.length },
      { label: "This week", value: weekJobsCount, changePercent: weekChangePct },
      { label: "Completed total", value: completedTotalCount },
    ],
    todaysJobs,
    upcomingJobs,
    weekEarnings: Math.round(weekEarnings * 100) / 100,
    weekCompleted: weekCompletedCount,
    weekRating: Number(weekRating.toFixed(1)),
    completedCount: completedTodayCount,
    unreadNotifications: unreadCount,
    activeLeave: activeLeave
      ? { id: activeLeave.id, startDate: activeLeave.startDate, endDate: activeLeave.endDate, status: activeLeave.status }
      : null,
    upcomingLeave: upcomingLeave
      ? { id: upcomingLeave.id, startDate: upcomingLeave.startDate, endDate: upcomingLeave.endDate, status: upcomingLeave.status }
      : null,
  };
};

export const dashboardService = {
  getDashboardOverview,
  getDashboardRevenueInsight,
  getRevenuePage,
  getStaffDashboard,
};
