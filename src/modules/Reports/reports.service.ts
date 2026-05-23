import { prisma } from "../../lib/prisma/prisma";
import { JobStatus } from "../../generated/prisma/enums";
import redis from "../../config/redis";

// ── Shared helper: resolve adminId from userId ────────────────────────────────

async function requireAdminProfile(userId: string) {
  const profile = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!profile) throw new Error("Admin profile not found.");
  return profile;
}

// ── Shared: resolve date range from period string ─────────────────────────────

type Period = "7d" | "30d" | "90d" | "12m";

function resolvePeriod(period: Period): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  const msDay = 86_400_000;

  if (period === "7d") from.setTime(to.getTime() - 7 * msDay);
  else if (period === "30d") from.setTime(to.getTime() - 30 * msDay);
  else if (period === "90d") from.setTime(to.getTime() - 90 * msDay);
  else {
    from.setFullYear(to.getFullYear() - 1);
  }
  return { from, to };
}

const MONTH_NAMES = [
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

function dateBucket(period: Period, d: Date): string {
  if (period === "7d")
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  if (period === "30d") return `Week ${Math.ceil(d.getDate() / 7)}`;
  return MONTH_NAMES[d.getMonth()]; // 90d & 12m
}

// ── Redis cache helpers ───────────────────────────────────────────────────────

const CACHE_TTL = 5 * 60; // 5 minutes

async function getCached<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function setCache(key: string, value: unknown): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), "EX", CACHE_TTL);
  } catch {
    // Non-fatal — cache miss is fine
  }
}

function cacheKey(reportType: string, adminId: string, period: string) {
  return `reports:${reportType}:${adminId}:${period}`;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function escapeCsv(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(",")),
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Result-shape types (used to thread the cache through with correct types)
// ─────────────────────────────────────────────────────────────────────────────

type StatWithChange = { value: number; changePercent: number };

type RevenueReportResult = {
  stats: {
    totalRevenue: StatWithChange;
    totalProfit: StatWithChange;
    avgJobValue: StatWithChange;
    outstandingInvoices: StatWithChange;
  };
  chart: { label: string; revenue: number; expenses: number; profit: number }[];
  byService: {
    serviceType: string;
    revenue: number;
    jobs: number;
    avgPerJob: number;
  }[];
  recentTransactions: {
    id: string;
    invoiceRef: string;
    clientName: string;
    serviceType: string;
    amount: number;
    paidDate: Date | null;
  }[];
};

type StaffPerformanceResult = {
  stats: {
    totalStaff: number;
    totalJobs: number;
    completedJobs: number;
    overallRate: number;
    overallRating: number;
  };
  staff: {
    staffId: string;
    name: string;
    avatar: string | null;
    totalJobs: number;
    completed: number;
    cancelled: number;
    completionRate: number;
    avgHoursPerJob: number;
    avgRating: number | null;
    reviewCount: number;
  }[];
};

type ClientRetentionResult = {
  stats: {
    totalClients: number;
    repeatClients: number;
    oneTimeClients: number;
    newClients: number;
    retentionRate: number;
    churnRate: number;
    avgBookingFreq: number;
  };
  topClients: {
    id: string;
    name: string;
    email: string;
    totalBookings: number;
    totalSpend: number;
    lastBookingDate: Date | null;
    isRepeat: boolean;
    status: string;
  }[];
  acquisitionChart: { label: string; count: number }[];
  clients: {
    id: string;
    name: string;
    email: string;
    totalBookings: number;
    totalSpend: number;
    lastBookingDate: Date | null;
    joinedDate: Date;
    isRepeat: boolean;
    status: string;
  }[];
};

type JobCompletionResult = {
  stats: {
    total: number;
    completed: number;
    cancelled: number;
    inProgress: number;
    completionRate: number;
    avgDurationMins: number;
  };
  chart: { label: string; completed: number; total: number; rate: number }[];
  byStaff: Record<string, unknown>[];
  byService: Record<string, unknown>[];
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Revenue Report
// ─────────────────────────────────────────────────────────────────────────────

export const getRevenueReport = async (
  userId: string,
  period: Period,
): Promise<RevenueReportResult> => {
  const admin = await requireAdminProfile(userId);
  const adminId = admin.id;

  const key = cacheKey("revenue", adminId, period);
  const cached = await getCached<RevenueReportResult>(key);
  if (cached) return cached;

  const { from, to } = resolvePeriod(period);

  const msDay = 86_400_000;
  const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  const prevTo = new Date(from.getTime() - msDay);

  const [
    paidCurrent,
    paidPrev,
    expensesCurrent,
    expensesPrev,
    outstanding,
    allPaidInvoices,
    allExpenses,
    recentTransactions,
    byServiceRaw,
  ] = await Promise.all([
    prisma.invoice.aggregate({
      where: { adminId, status: "PAID", paidDate: { gte: from, lte: to } },
      _sum: { total: true },
    }),
    prisma.invoice.aggregate({
      where: {
        adminId,
        status: "PAID",
        paidDate: { gte: prevFrom, lte: prevTo },
      },
      _sum: { total: true },
    }),
    prisma.expense.aggregate({
      where: { adminId, date: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { adminId, date: { gte: prevFrom, lte: prevTo } },
      _sum: { amount: true },
    }),
    prisma.invoice.aggregate({
      where: { adminId, status: { not: "PAID" } },
      _sum: { total: true },
    }),
    prisma.invoice.findMany({
      where: { adminId, status: "PAID", paidDate: { gte: from, lte: to } },
      select: { total: true, paidDate: true },
    }),
    prisma.expense.findMany({
      where: { adminId, date: { gte: from, lte: to } },
      select: { amount: true, date: true },
    }),
    prisma.invoice.findMany({
      where: { adminId, status: "PAID", paidDate: { gte: from, lte: to } },
      orderBy: { paidDate: "desc" },
      take: 10,
      select: {
        id: true,
        invoiceRef: true,
        total: true,
        paidDate: true,
        clientName: true,
        booking: {
          select: {
            client: { select: { name: true } },
            serviceType: true,
          },
        },
      },
    }),
    prisma.invoice.findMany({
      where: { adminId, status: "PAID", paidDate: { gte: from, lte: to } },
      select: { total: true, booking: { select: { serviceType: true } } },
    }),
  ]);

  const totalRevenue = Number(paidCurrent._sum.total ?? 0);
  const prevRevenue = Number(paidPrev._sum.total ?? 0);
  const totalExpenses = Number(expensesCurrent._sum.amount ?? 0);
  const prevExpenses = Number(expensesPrev._sum.amount ?? 0);
  const totalProfit = totalRevenue - totalExpenses;
  const prevProfit = prevRevenue - prevExpenses;

  const pct = (cur: number, prev: number) =>
    prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 100);

  const jobCount = allPaidInvoices.length;
  const avgJobValue = jobCount > 0 ? Math.round(totalRevenue / jobCount) : 0;

  const chartMap: Record<string, { revenue: number; expenses: number }> = {};
  const ensureBucket = (key: string) => {
    if (!chartMap[key]) chartMap[key] = { revenue: 0, expenses: 0 };
  };

  for (const inv of allPaidInvoices) {
    if (!inv.paidDate) continue;
    const key = dateBucket(period, inv.paidDate);
    ensureBucket(key);
    chartMap[key].revenue += Number(inv.total);
  }
  for (const exp of allExpenses) {
    const key = dateBucket(period, exp.date);
    ensureBucket(key);
    chartMap[key].expenses += Number(exp.amount);
  }

  const chart = Object.entries(chartMap).map(([label, d]) => ({
    label,
    revenue: Math.round(d.revenue),
    expenses: Math.round(d.expenses),
    profit: Math.round(d.revenue - d.expenses),
  }));

  const svcMap: Record<string, { revenue: number; jobs: number }> = {};
  for (const inv of byServiceRaw) {
    const svcType = inv.booking?.serviceType ?? "Unknown";
    if (!svcMap[svcType]) svcMap[svcType] = { revenue: 0, jobs: 0 };
    svcMap[svcType].revenue += Number(inv.total);
    svcMap[svcType].jobs++;
  }
  const byService = Object.entries(svcMap)
    .map(([serviceType, d]) => ({
      serviceType,
      revenue: Math.round(d.revenue),
      jobs: d.jobs,
      avgPerJob: d.jobs > 0 ? Math.round(d.revenue / d.jobs) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const transactions = recentTransactions.map((inv) => ({
    id: inv.id,
    invoiceRef: inv.invoiceRef,
    clientName: inv.booking?.client?.name ?? inv.clientName ?? "—",
    serviceType: inv.booking?.serviceType ?? "—",
    amount: Number(inv.total),
    paidDate: inv.paidDate,
  }));

  const result = {
    stats: {
      totalRevenue: {
        value: totalRevenue,
        changePercent: pct(totalRevenue, prevRevenue),
      },
      totalProfit: {
        value: totalProfit,
        changePercent: pct(totalProfit, prevProfit),
      },
      avgJobValue: { value: avgJobValue, changePercent: 0 },
      outstandingInvoices: {
        value: Number(outstanding._sum.total ?? 0),
        changePercent: 0,
      },
    },
    chart,
    byService,
    recentTransactions: transactions,
  };

  await setCache(key, result);
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Staff Performance Report
// ─────────────────────────────────────────────────────────────────────────────

export const getStaffPerformanceReport = async (
  userId: string,
  period: Period,
): Promise<StaffPerformanceResult> => {
  const admin = await requireAdminProfile(userId);
  const adminId = admin.id;

  const key = cacheKey("staff-performance", adminId, period);
  const cached = await getCached<StaffPerformanceResult>(key);
  if (cached) return cached;

  const { from, to } = resolvePeriod(period);

  const jobs = await prisma.job.findMany({
    where: { adminId, scheduledDate: { gte: from, lte: to } },
    select: {
      id: true,
      status: true,
      durationMins: true,
      staffAssignments: {
        select: {
          staffId: true,
          staff: {
            select: {
              user: { select: { id: true, name: true, image: true } },
            },
          },
        },
      },
      reviewToken: {
        select: {
          reviews: {
            where: { NOT: { staffId: null } },
            select: { staffId: true, rating: true },
          },
        },
      },
    },
  });

  type StaffEntry = {
    staffId: string;
    name: string;
    avatar: string | null;
    totalJobs: number;
    completed: number;
    cancelled: number;
    totalMins: number;
    ratingSum: number;
    ratingCount: number;
  };
  const map = new Map<string, StaffEntry>();

  for (const job of jobs) {
    for (const assign of job.staffAssignments) {
      const sid = assign.staffId;
      const user = assign.staff.user;
      if (!map.has(sid)) {
        map.set(sid, {
          staffId: sid,
          name: user.name,
          avatar: user.image ?? null,
          totalJobs: 0,
          completed: 0,
          cancelled: 0,
          totalMins: 0,
          ratingSum: 0,
          ratingCount: 0,
        });
      }
      const e = map.get(sid)!;
      e.totalJobs++;
      if (job.status === JobStatus.COMPLETED) {
        e.completed++;
        e.totalMins += job.durationMins;
      }
      if (job.status === JobStatus.CANCELLED) e.cancelled++;

      if (job.reviewToken) {
        for (const rev of job.reviewToken.reviews) {
          if (rev.staffId === sid) {
            e.ratingSum += rev.rating;
            e.ratingCount++;
          }
        }
      }
    }
  }

  const staff = Array.from(map.values())
    .map((e) => ({
      staffId: e.staffId,
      name: e.name,
      avatar: e.avatar,
      totalJobs: e.totalJobs,
      completed: e.completed,
      cancelled: e.cancelled,
      completionRate:
        e.totalJobs > 0 ? Math.round((e.completed / e.totalJobs) * 100) : 0,
      avgHoursPerJob:
        e.completed > 0
          ? Math.round((e.totalMins / e.completed / 60) * 10) / 10
          : 0,
      avgRating:
        e.ratingCount > 0
          ? Math.round((e.ratingSum / e.ratingCount) * 10) / 10
          : null,
      reviewCount: e.ratingCount,
    }))
    .sort((a, b) => b.completed - a.completed);

  const totalJobs = jobs.length;
  const completedJobs = jobs.filter(
    (j) => j.status === JobStatus.COMPLETED,
  ).length;
  const overallRate =
    totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0;

  const staffWithRatings = staff.filter((s) => s.avgRating !== null);
  const overallRating =
    staffWithRatings.length > 0
      ? Math.round(
          (staffWithRatings.reduce((s, r) => s + (r.avgRating ?? 0), 0) /
            staffWithRatings.length) *
            10,
        ) / 10
      : 0;

  const result = {
    stats: {
      totalStaff: staff.length,
      totalJobs,
      completedJobs,
      overallRate,
      overallRating,
    },
    staff,
  };

  await setCache(key, result);
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Client Retention Report
// ─────────────────────────────────────────────────────────────────────────────

export const getClientRetentionReport = async (
  userId: string,
  period: Period,
): Promise<ClientRetentionResult> => {
  const admin = await requireAdminProfile(userId);
  const adminId = admin.id;

  const key = cacheKey("client-retention", adminId, period);
  const cached = await getCached<ClientRetentionResult>(key);
  if (cached) return cached;

  const { from, to } = resolvePeriod(period);

  const clients = await prisma.client.findMany({
    where: { adminId },
    select: {
      id: true,
      name: true,
      email: true,
      totalBookings: true,
      totalSpend: true,
      lastBookingDate: true,
      createdAt: true,
      status: true,
    },
    orderBy: { totalBookings: "desc" },
  });

  const newClients = clients.filter(
    (c) => c.createdAt >= from && c.createdAt <= to,
  );
  const repeat = clients.filter((c) => c.totalBookings > 1);
  const oneTime = clients.filter((c) => c.totalBookings <= 1);
  const churn = clients.filter((c) => c.status === "INACTIVE");

  const retentionRate =
    clients.length > 0 ? Math.round((repeat.length / clients.length) * 100) : 0;
  const churnRate =
    clients.length > 0 ? Math.round((churn.length / clients.length) * 100) : 0;
  const avgBookingFreq =
    repeat.length > 0
      ? Math.round(
          (repeat.reduce((s, c) => s + c.totalBookings, 0) / repeat.length) *
            10,
        ) / 10
      : 0;

  const topClients = [...clients]
    .sort((a, b) => Number(b.totalSpend) - Number(a.totalSpend))
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      totalBookings: c.totalBookings,
      totalSpend: Number(c.totalSpend),
      lastBookingDate: c.lastBookingDate,
      isRepeat: c.totalBookings > 1,
      status: c.status,
    }));

  const acquisitionMap: Record<string, number> = {};
  for (const c of newClients) {
    const k = dateBucket(period, c.createdAt);
    acquisitionMap[k] = (acquisitionMap[k] ?? 0) + 1;
  }
  const acquisitionChart = Object.entries(acquisitionMap).map(
    ([label, count]) => ({
      label,
      count,
    }),
  );

  const result = {
    stats: {
      totalClients: clients.length,
      repeatClients: repeat.length,
      oneTimeClients: oneTime.length,
      newClients: newClients.length,
      retentionRate,
      churnRate,
      avgBookingFreq,
    },
    topClients,
    acquisitionChart,
    clients: clients.slice(0, 100).map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      totalBookings: c.totalBookings,
      totalSpend: Number(c.totalSpend),
      lastBookingDate: c.lastBookingDate,
      joinedDate: c.createdAt,
      isRepeat: c.totalBookings > 1,
      status: c.status,
    })),
  };

  await setCache(key, result);
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Job Completion Report
// ─────────────────────────────────────────────────────────────────────────────

export const getJobCompletionReport = async (
  userId: string,
  period: Period,
): Promise<JobCompletionResult> => {
  const admin = await requireAdminProfile(userId);
  const adminId = admin.id;

  const key = cacheKey("job-completion", adminId, period);
  const cached = await getCached<JobCompletionResult>(key);
  if (cached) return cached;

  const { from, to } = resolvePeriod(period);

  const jobs = await prisma.job.findMany({
    where: { adminId, scheduledDate: { gte: from, lte: to } },
    select: {
      id: true,
      status: true,
      durationMins: true,
      scheduledDate: true,
      serviceType: true,
      staffAssignments: {
        select: {
          staffId: true,
          staff: {
            select: { user: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });

  const total = jobs.length;
  const completed = jobs.filter((j) => j.status === JobStatus.COMPLETED).length;
  const cancelled = jobs.filter((j) => j.status === JobStatus.CANCELLED).length;
  const inProgress = jobs.filter(
    (j) => j.status === JobStatus.IN_PROGRESS,
  ).length;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  const completedJobs = jobs.filter((j) => j.status === JobStatus.COMPLETED);
  const avgDurationMins =
    completedJobs.length > 0
      ? Math.round(
          completedJobs.reduce((s, j) => s + j.durationMins, 0) /
            completedJobs.length,
        )
      : 0;

  const staffMap = new Map<
    string,
    { name: string; completed: number; total: number }
  >();
  for (const job of jobs) {
    for (const assign of job.staffAssignments) {
      const sid = assign.staffId;
      const name = assign.staff.user.name;
      if (!staffMap.has(sid))
        staffMap.set(sid, { name, completed: 0, total: 0 });
      const e = staffMap.get(sid)!;
      e.total++;
      if (job.status === JobStatus.COMPLETED) e.completed++;
    }
  }
  const byStaff = Array.from(staffMap.values())
    .map((e) => ({
      name: e.name,
      completed: e.completed,
      total: e.total,
      rate: e.total > 0 ? Math.round((e.completed / e.total) * 100) : 0,
    }))
    .sort((a, b) => b.completed - a.completed);

  const serviceMap: Record<string, { completed: number; total: number }> = {};
  for (const job of jobs) {
    const svc = job.serviceType ?? "Unknown";
    if (!serviceMap[svc]) serviceMap[svc] = { completed: 0, total: 0 };
    serviceMap[svc].total++;
    if (job.status === JobStatus.COMPLETED) serviceMap[svc].completed++;
  }
  const byService = Object.entries(serviceMap)
    .map(([serviceType, v]) => ({
      serviceType,
      completed: v.completed,
      total: v.total,
      rate: v.total > 0 ? Math.round((v.completed / v.total) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const chartMap: Record<string, { completed: number; total: number }> = {};
  for (const job of jobs) {
    if (!job.scheduledDate) continue;
    const k = dateBucket(period, job.scheduledDate);
    if (!chartMap[k]) chartMap[k] = { completed: 0, total: 0 };
    chartMap[k].total++;
    if (job.status === JobStatus.COMPLETED) chartMap[k].completed++;
  }
  const chart = Object.entries(chartMap).map(([label, v]) => ({
    label,
    completed: v.completed,
    total: v.total,
    rate: v.total > 0 ? Math.round((v.completed / v.total) * 100) : 0,
  }));

  const result = {
    stats: {
      total,
      completed,
      cancelled,
      inProgress,
      completionRate,
      avgDurationMins,
    },
    chart,
    byStaff,
    byService,
  };

  await setCache(key, result);
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Export helpers  (CSV streams)
// ─────────────────────────────────────────────────────────────────────────────

export const exportRevenueReportCsv = async (
  userId: string,
  period: Period,
): Promise<string> => {
  const data = await getRevenueReport(userId, period);

  const sections: string[] = [];

  // Summary stats
  const statsRows = [
    {
      metric: "Total Revenue",
      value: data.stats.totalRevenue.value,
      change_pct: data.stats.totalRevenue.changePercent,
    },
    {
      metric: "Total Profit",
      value: data.stats.totalProfit.value,
      change_pct: data.stats.totalProfit.changePercent,
    },
    {
      metric: "Avg Job Value",
      value: data.stats.avgJobValue.value,
      change_pct: data.stats.avgJobValue.changePercent,
    },
    {
      metric: "Outstanding Invoices",
      value: data.stats.outstandingInvoices.value,
      change_pct: data.stats.outstandingInvoices.changePercent,
    },
  ];
  sections.push("# Summary\n" + toCsv(statsRows));

  // Chart data
  sections.push("\n# Revenue Trend\n" + toCsv(data.chart));

  // By service
  sections.push("\n# Revenue By Service\n" + toCsv(data.byService));

  // Transactions
  const txRows = data.recentTransactions.map((tx) => ({
    invoice_ref: tx.invoiceRef,
    client: tx.clientName,
    service_type: tx.serviceType,
    amount: tx.amount,
    paid_date: tx.paidDate ?? "",
  }));
  sections.push("\n# Recent Transactions\n" + toCsv(txRows));

  return sections.join("\n");
};

export const exportStaffPerformanceCsv = async (
  userId: string,
  period: Period,
): Promise<string> => {
  const data = await getStaffPerformanceReport(userId, period);

  const rows = data.staff.map((s) => ({
    staff_name: s.name,
    total_jobs: s.totalJobs,
    completed: s.completed,
    cancelled: s.cancelled,
    completion_rate_pct: s.completionRate,
    avg_hours_per_job: s.avgHoursPerJob,
    avg_rating: s.avgRating ?? "",
    review_count: s.reviewCount,
  }));

  return toCsv(rows);
};

export const exportClientRetentionCsv = async (
  userId: string,
  period: Period,
): Promise<string> => {
  const data = await getClientRetentionReport(userId, period);

  const sections: string[] = [];

  const statsRows = [
    { metric: "Total Clients", value: data.stats.totalClients },
    { metric: "Repeat Clients", value: data.stats.repeatClients },
    { metric: "One-Time Clients", value: data.stats.oneTimeClients },
    { metric: "New Clients (period)", value: data.stats.newClients },
    { metric: "Retention Rate %", value: data.stats.retentionRate },
    { metric: "Churn Rate %", value: data.stats.churnRate },
    { metric: "Avg Bookings/Repeat", value: data.stats.avgBookingFreq },
  ];
  sections.push("# Summary\n" + toCsv(statsRows));

  const clientRows = data.clients.map((c) => ({
    name: c.name,
    email: c.email,
    total_bookings: c.totalBookings,
    total_spend: c.totalSpend,
    last_booking: c.lastBookingDate ?? "",
    joined: c.joinedDate,
    type: c.isRepeat ? "Repeat" : "One-time",
    status: c.status,
  }));
  sections.push("\n# Client List\n" + toCsv(clientRows));

  return sections.join("\n");
};

export const exportJobCompletionCsv = async (
  userId: string,
  period: Period,
): Promise<string> => {
  const data = await getJobCompletionReport(userId, period);

  const sections: string[] = [];

  const statsRows = [
    { metric: "Total Jobs", value: data.stats.total },
    { metric: "Completed", value: data.stats.completed },
    { metric: "Cancelled", value: data.stats.cancelled },
    { metric: "In Progress", value: data.stats.inProgress },
    { metric: "Completion Rate %", value: data.stats.completionRate },
    { metric: "Avg Duration (mins)", value: data.stats.avgDurationMins },
  ];
  sections.push("# Summary\n" + toCsv(statsRows));
  sections.push("\n# By Staff\n" + toCsv(data.byStaff));
  sections.push("\n# By Service\n" + toCsv(data.byService));

  return sections.join("\n");
};

export const reportsService = {
  getRevenueReport,
  getStaffPerformanceReport,
  getClientRetentionReport,
  getJobCompletionReport,
  exportRevenueReportCsv,
  exportStaffPerformanceCsv,
  exportClientRetentionCsv,
  exportJobCompletionCsv,
};
