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

  const filterHash = createHash("sha1")
    .update(JSON.stringify({ status: statusEnum ?? "all", search: search ?? "", limit: takeLimit }))
    .digest("hex")
    .slice(0, 12);
  const cacheKey = CacheNamespaces.dashboardSummary(adminId, `${period}:${filterHash}`);
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

  const recentBookingsWhere: any = {
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
        (SELECT ap.currency::text FROM "AdminProfile" ap WHERE ap.id = ${adminId} LIMIT 1) AS currency
    `,
    prisma.$queryRaw<ChartRow[]>`
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
    `,
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
    stats,
    revenueInsight,
    recentBookings,
    topStaff,
    monthlyRecurringValue: Math.round(Number(summary.monthlyRecurringValue ?? 0)),
  };

  await redis.setex(cacheKey, ttlForKey(CacheTtl.dashboardSummary, cacheKey), JSON.stringify(result)).catch(() => {});
  return result;
};

// ─── Revenue Page ─────────────────────────────────────────────────────────────

type RevenuePeriod = "7d" | "30d" | "90d" | "12m";

const getRevenuePage = async (
  user: IRequestUser | string,
  period: RevenuePeriod,
) => {
  const adminId = typeof user === "string" ? user : await getAdminId(user);

  // PERF FIX #14: Revenue page ran 11 parallel DB queries with zero caching.
  // Every filter-period change hit the DB cold. Apply 5-minute Redis cache
  // keyed by adminId + period so repeat loads within the window are instant.
  const revCacheKey = `dashboard:revenue:${adminId}:${period}`;
  const revCached = await redis.get(revCacheKey).catch(() => null);
  if (revCached) {
    try {
      return JSON.parse(revCached);
    } catch {
      // fall through on corrupt entry
    }
  }

  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  let from: Date;
  let bucketFn: (d: Date) => string;
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  if (period === "7d") {
    from = new Date(now.getTime() - 7 * msPerDay);
    bucketFn = (d) =>
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  } else if (period === "30d") {
    from = new Date(now.getTime() - 30 * msPerDay);
    bucketFn = (d) => `Week ${Math.ceil(d.getDate() / 7)}`;
  } else if (period === "90d") {
    from = new Date(now.getTime() - 90 * msPerDay);
    bucketFn = (d) => monthNames[d.getMonth()];
  } else {
    from = new Date(now);
    from.setFullYear(from.getFullYear() - 1);
    bucketFn = (d) => monthNames[d.getMonth()];
  }

  const prev = previousPeriod(from, now);

  const bucketUnit: "day" | "month" =
    period === "90d" || period === "12m" ? "month" : "day";

  const [
    paidCur,
    paidPrev,
    expCur,
    expPrev,
    outstandingRaw,
    dailyRevenue,
    dailyExpenses,
    serviceGroups,
    recentInv,
    staffWithJobsRaw,
    jobCountCurrent,
    revenueAdminProfile,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        adminId,
        status: InvoiceStatus.PAID,
        paidDate: { gte: from, lte: now },
      },
      _sum: { total: true },
    }),
    prisma.invoice.aggregate({
      where: { adminId, status: InvoiceStatus.PAID, paidDate: prev },
      _sum: { total: true },
    }),
    prisma.expense.aggregate({
      where: { adminId, date: { gte: from, lte: now } },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { adminId, date: prev },
      _sum: { amount: true },
    }),
    prisma.invoice.aggregate({
      where: {
        adminId,
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.OVERDUE] },
      },
      _sum: { total: true },
    }),
    prisma.$queryRaw<{ bucket: Date; total: string | null }[]>`
      SELECT date_trunc(${bucketUnit}, "paidDate") AS bucket,
             COALESCE(SUM("total"), 0) AS total
      FROM "invoice"
      WHERE "adminId" = ${adminId}
        AND "status" = 'PAID'
        AND "paidDate" BETWEEN ${from} AND ${now}
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.$queryRaw<{ bucket: Date; total: string | null }[]>`
      SELECT date_trunc(${bucketUnit}, "date") AS bucket,
             COALESCE(SUM("amount"), 0) AS total
      FROM "expense"
      WHERE "adminId" = ${adminId}
        AND "date" BETWEEN ${from} AND ${now}
      GROUP BY 1
      ORDER BY 1
    `,
    prisma.invoice.groupBy({
      by: ["serviceCatalogId"],
      where: {
        adminId,
        status: InvoiceStatus.PAID,
        paidDate: { gte: from, lte: now },
      },
      _sum: { total: true },
      _count: { _all: true },
    }),
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
    // PERF FIX (Phase 2.4): SQL aggregate for staffWithJobs in getRevenuePage
    prisma.$queryRaw<
      { userId: string; name: string; image: string | null; jobCount: bigint }[]
    >`
      SELECT
        u.id AS "userId",
        u.name,
        u.image,
        COUNT(jsa."jobId") AS "jobCount"
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
    // PERF FIX (Phase 1.6): Move jobCountCurrent into Promise.all array
    prisma.job.count({
      where: {
        adminId,
        status: JobStatus.COMPLETED,
        updatedAt: { gte: from, lte: now },
      },
    }),
    prisma.adminProfile.findUnique({ where: { id: adminId }, select: { currency: true } }),
  ]);

  const totalRevenue = Number(paidCur._sum.total ?? 0);
  const prevRevenue = Number(paidPrev._sum.total ?? 0);
  const totalExpenses = Number(expCur._sum.amount ?? 0);
  const prevExpenses = Number(expPrev._sum.amount ?? 0);
  const totalProfit = totalRevenue - totalExpenses;
  const prevProfit = prevRevenue - prevExpenses;
  const outstanding = Number(outstandingRaw._sum.total ?? 0);
  const revenueCurrency = revenueAdminProfile?.currency ?? "USD";
  const revenuePrefix = currencyPrefix(revenueCurrency);

  const chartMap: Record<string, { revenue: number; expenses: number }> = {};
  for (const row of dailyRevenue) {
    if (!row.bucket) continue;
    const k = bucketFn(new Date(row.bucket));
    if (!chartMap[k]) chartMap[k] = { revenue: 0, expenses: 0 };
    chartMap[k].revenue += Number(row.total ?? 0);
  }
  for (const row of dailyExpenses) {
    if (!row.bucket) continue;
    const k = bucketFn(new Date(row.bucket));
    if (!chartMap[k]) chartMap[k] = { revenue: 0, expenses: 0 };
    chartMap[k].expenses += Number(row.total ?? 0);
  }
  const chart = Object.entries(chartMap).map(([label, d]) => ({
    label,
    revenue: d.revenue,
    expenses: d.expenses,
    profit: d.revenue - d.expenses,
  }));

  const serviceIds = serviceGroups
    .map((g) => g.serviceCatalogId)
    .filter((id): id is string => Boolean(id));
  const serviceCatalogs = serviceIds.length
    ? await prisma.serviceCatalog.findMany({
        where: { id: { in: serviceIds } },
        select: { id: true, serviceName: true },
      })
    : [];
  const serviceNameMap = new Map(
    serviceCatalogs.map((s) => [s.id, s.serviceName]),
  );

  const byService = serviceGroups.map((g) => {
    const revenue = Number(g._sum.total ?? 0);
    const jobs = g._count._all;
    return {
      serviceType: g.serviceCatalogId
        ? (serviceNameMap.get(g.serviceCatalogId) ?? "Other")
        : "Other",
      revenue,
      jobs,
      avgPerJob: jobs > 0 ? Math.round(revenue / jobs) : 0,
      changePercent: 0,
    };
  });
  const byStaff = staffWithJobsRaw
    .map((s) => ({
      staffId: s.userId,
      name: s.name,
      avatar: s.image ?? undefined,
      revenue: 0,
      jobs: Number(s.jobCount),
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
      totalRevenue: {
        label: "Total Revenue",
        value: totalRevenue,
        changePercent: pct(totalRevenue, prevRevenue),
        prefix: revenuePrefix,
      },
      totalProfit: {
        label: "Net Profit",
        value: totalProfit,
        changePercent: pct(totalProfit, prevProfit),
        prefix: revenuePrefix,
      },
      avgJobValue: {
        label: "Avg. Job Value",
        value:
          jobCountCurrent > 0 ? Math.round(totalRevenue / jobCountCurrent) : 0,
        changePercent: 0,
        prefix: revenuePrefix,
      },
      outstandingInvoices: {
        label: "Outstanding Invoices",
        value: outstanding,
        changePercent: 0,
        prefix: revenuePrefix,
      },
    },
    chart,
    byService,
    byStaff,
    recentTransactions,
  };

  // PERF FIX #14: Write revenue page result to Redis for 5 minutes.
  // Revenue figures are not real-time — 5-minute staleness is acceptable.
  await redis
    .setex(revCacheKey, 300, JSON.stringify(revenueResult))
    .catch(() => {});

  return revenueResult;
};

// ─── Helpers shared by getStaffDashboard ──────────────────────────────────────

const requireStaffProfile = async (userId: string) => {
  const staff = await prisma.staffProfile.findFirst({
    where: { userId },
    include: { user: { select: { name: true, image: true } } },
  });
  if (!staff) throw new AppError(status.NOT_FOUND, "Staff profile not found");
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

// ─── Staff Dashboard Overview ─────────────────────────────────────────────────
//
// Additions vs previous version:
//  • weekEarnings  — sum of hoursWorked × hourlyRate for the current week
//  • weekRating    — avg review rating received this week
//  • weekCompleted — completed jobs this week (for the stats bar)
//  • completedCount — today's completed jobs count (for the dashboard greeting)
//  • unreadNotifications — badge count for the bell icon
//  • activeLeave   — current approved leave record (if any), so the profile
//                    page can show an "On leave" banner
//  • upcomingLeave — next pending or approved leave request

const getStaffDashboard = async (userId: string) => {
  // PERF FIX #12: Staff dashboard had no caching — every load hit the DB
  // with 11 parallel queries. Apply the same 5-minute Redis cache pattern
  // as the admin dashboard. The short TTL still reflects job changes fast.
  const staffCacheKey = `dashboard:staff:${userId}`;
  const staffCached = await redis.get(staffCacheKey).catch(() => null);
  if (staffCached) {
    try {
      return JSON.parse(staffCached);
    } catch {
      // fall through on corrupt entry
    }
  }

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

  const [
    todaysAssignments,
    upcomingAssignments,
    weekJobsCount,
    prevWeekJobsCount,
    completedTotalCount,
    completedTodayCount,
    weekCompletedCount,
    unreadCount,
    weekReviewAgg,
    weekAssignmentsForEarnings,
    leaveRecords,
  ] = await Promise.all([
    // Today's jobs
    prisma.jobStaffAssignment.findMany({
      where: {
        staffId,
        job: {
          scheduledDate: { gte: todayStart, lte: todayEnd },
          status: { not: JobStatus.CANCELLED },
        },
      },
      include: {
        job: {
          include: {
            client: { select: { name: true, phone: true, email: true } },
            checklists: {
              include: { items: { select: { id: true, completed: true } } },
            },
          },
        },
      },
      orderBy: { job: { scheduledDate: "asc" } },
    }),
    // Upcoming (next 7 days)
    prisma.jobStaffAssignment.findMany({
      where: {
        staffId,
        job: {
          scheduledDate: {
            gt: todayEnd,
            lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          },
          status: { not: JobStatus.CANCELLED },
        },
      },
      include: {
        job: {
          include: {
            client: { select: { name: true, phone: true, email: true } },
            checklists: {
              include: { items: { select: { id: true, completed: true } } },
            },
          },
        },
      },
      orderBy: { job: { scheduledDate: "asc" } },
      take: 10,
    }),
    // Jobs this week (for stats bar)
    prisma.jobStaffAssignment.count({
      where: { staffId, job: { scheduledDate: { gte: weekStart, lte: now } } },
    }),
    // Jobs prev week (for changePercent)
    prisma.jobStaffAssignment.count({
      where: {
        staffId,
        job: { scheduledDate: { gte: prevWeekStart, lte: prevWeekEnd } },
      },
    }),
    // Total completed ever
    prisma.jobStaffAssignment.count({
      where: { staffId, job: { status: JobStatus.COMPLETED } },
    }),
    // Completed today (for "you're done!" greeting)
    prisma.jobStaffAssignment.count({
      where: {
        staffId,
        job: {
          status: JobStatus.COMPLETED,
          updatedAt: { gte: todayStart, lte: todayEnd },
        },
      },
    }),
    // Completed this week
    prisma.jobStaffAssignment.count({
      where: {
        staffId,
        job: {
          status: JobStatus.COMPLETED,
          updatedAt: { gte: weekStart, lte: now },
        },
      },
    }),
    // Unread notifications scoped to this staff member's adminId.
    // PERF FIX #13 (partial): The Notification model currently has no
    // per-recipient field — it only tracks adminId. Until a `recipientId`
    // column is added via migration (see prisma/schema/admin.prisma), we
    // filter by adminId AND limit to a small recent window to avoid a full
    // table scan on busy accounts.
    prisma.notification.count({
      where: {
        adminId: staffProfile.adminId,
        isRead: false,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    }),
    // Avg review rating this week
    prisma.review.aggregate({
      where: { staffId, createdAt: { gte: weekStart, lte: now } },
      _avg: { rating: true },
    }),
    // This week's completed assignments with hoursWorked for earnings calc
    prisma.jobStaffAssignment.findMany({
      where: {
        staffId,
        checkOutAt: { gte: weekStart, lte: now },
        hoursWorked: { not: null },
      },
      select: { hoursWorked: true },
    }),
    // Leave records: active + upcoming
    prisma.staffLeave.findMany({
      where: {
        staffId,
        status: { in: [LeaveStatus.PENDING, LeaveStatus.APPROVED] },
        endDate: { gte: todayStart },
      },
      orderBy: { startDate: "asc" },
    }),
  ]);

  // ── Earnings this week ───────────────────────────────────────────────────
  const hourlyRate = staffProfile.hourlyRate ?? 0;
  const weekEarnings = weekAssignmentsForEarnings.reduce(
    (sum, a) => sum + Number(a.hoursWorked ?? 0) * hourlyRate,
    0,
  );

  // ── Leave status ─────────────────────────────────────────────────────────
  const activeLeave =
    leaveRecords.find(
      (l) =>
        l.status === LeaveStatus.APPROVED &&
        l.startDate <= now &&
        l.endDate >= now,
    ) ?? null;
  const upcomingLeave = leaveRecords.find((l) => l.startDate > now) ?? null;

  // ── Shape jobs ───────────────────────────────────────────────────────────
  const shapeJob = (assignment: (typeof todaysAssignments)[0]) => {
    const job = assignment.job;
    const checklistTotal = job.checklists.reduce(
      (acc, cl) => acc + cl.items.length,
      0,
    );
    const checklistDone = job.checklists.reduce(
      (acc, cl) => acc + cl.items.filter((i) => i.completed).length,
      0,
    );
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
      checklistTotal,
      checklistDone,
    };
  };

  const todaysJobs = todaysAssignments.map(shapeJob);
  const upcomingJobs = upcomingAssignments.map(shapeJob);

  // ── Stats ────────────────────────────────────────────────────────────────
  const weekChangePct =
    prevWeekJobsCount === 0
      ? 0
      : Math.round(
          ((weekJobsCount - prevWeekJobsCount) / prevWeekJobsCount) * 100,
        );
  const stats = [
    { label: "Jobs today", value: todaysJobs.length },
    { label: "This week", value: weekJobsCount, changePercent: weekChangePct },
    { label: "Completed total", value: completedTotalCount },
  ];

  const staffName = staffProfile.user.name;
  const initials = staffName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const staffResult = {
    staffId,
    staffName,
    avatarInitials: initials,
    avatarUrl: staffProfile.user.image ?? undefined,
    stats,
    todaysJobs,
    upcomingJobs,
    // Extended fields consumed by StaffDashboardContent
    weekEarnings: Math.round(weekEarnings * 100) / 100,
    weekCompleted: weekCompletedCount,
    weekRating: Number((weekReviewAgg._avg.rating ?? 0).toFixed(1)),
    completedCount: completedTodayCount,
    unreadNotifications: unreadCount,
    // Leave info for profile page and dashboard banner
    activeLeave: activeLeave
      ? {
          id: activeLeave.id,
          startDate: activeLeave.startDate,
          endDate: activeLeave.endDate,
          status: activeLeave.status,
        }
      : null,
    upcomingLeave: upcomingLeave
      ? {
          id: upcomingLeave.id,
          startDate: upcomingLeave.startDate,
          endDate: upcomingLeave.endDate,
          status: upcomingLeave.status,
        }
      : null,
  };

  // PERF FIX #12: Write staff dashboard result to Redis for 5 minutes.
  // This eliminates the 11-query DB hit on every staff page load.
  // Job status updates from Socket.IO invalidate this key when needed.
  await redis
    .setex(staffCacheKey, 300, JSON.stringify(staffResult))
    .catch(() => {});

  return staffResult;
};

export const dashboardService = {
  getDashboardOverview,
  getRevenuePage,
  getStaffDashboard,
};
