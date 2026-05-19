import { prisma } from "../../lib/prisma/prisma";
import { JobStatus } from "../../generated/prisma/enums";

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
        // 12m — one calendar year back
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. Revenue Report
// ─────────────────────────────────────────────────────────────────────────────

export const getRevenueReport = async (userId: string, period: Period) => {
    const admin = await requireAdminProfile(userId);
    const adminId = admin.id;
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
            where: {
                adminId,
                status: "PAID",
                paidDate: { gte: from, lte: to },
            },
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
        // For chart buckets
        prisma.invoice.findMany({
            where: {
                adminId,
                status: "PAID",
                paidDate: { gte: from, lte: to },
            },
            select: { total: true, paidDate: true },
            // include: {}
        }),
        prisma.expense.findMany({
            where: { adminId, date: { gte: from, lte: to } },
            select: { amount: true, date: true },
        }),
        // Recent transactions (last 10 paid invoices)
        prisma.invoice.findMany({
            where: {
                adminId,
                status: "PAID",
                paidDate: { gte: from, lte: to },
            },
            orderBy: { paidDate: "desc" },
            take: 10,
            select: {
                id: true,
                invoiceRef: true,
                total: true,
                paidDate: true,
                booking: {
                    select: {
                        client: { select: { name: true } },
                        serviceType: true,
                    },
                },
            },
        }),
        // Revenue by service type
        prisma.invoice.findMany({
            where: {
                adminId,
                status: "PAID",
                paidDate: { gte: from, lte: to },
            },
            select: {
                total: true,
                booking: { select: { serviceType: true } },
            },
        }),
    ]);

    // ── KPI stats ───────────────────────────────────────────────────────────────
    const totalRevenue = Number(paidCurrent._sum.total ?? 0);
    const prevRevenue = Number(paidPrev._sum.total ?? 0);
    const totalExpenses = Number(expensesCurrent._sum.amount ?? 0);
    const prevExpenses = Number(expensesPrev._sum.amount ?? 0);
    const totalProfit = totalRevenue - totalExpenses;
    const prevProfit = prevRevenue - prevExpenses;

    const pct = (cur: number, prev: number) =>
        prev === 0
            ? cur > 0
                ? 100
                : 0
            : Math.round(((cur - prev) / prev) * 100);

    // Count jobs for avg job value
    const jobCount = allPaidInvoices.length;
    const avgJobValue = jobCount > 0 ? Math.round(totalRevenue / jobCount) : 0;

    // ── Chart buckets ───────────────────────────────────────────────────────────
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

    // ── By service type ─────────────────────────────────────────────────────────
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

    // ── Recent transactions ─────────────────────────────────────────────────────
    const transactions = recentTransactions.map((inv) => ({
        id: inv.id,
        invoiceRef: inv.invoiceRef,
        clientName: inv.booking?.client?.name ?? "—",
        serviceType: inv.booking?.serviceType ?? "—",
        amount: Number(inv.total),
        paidDate: inv.paidDate,
    }));

    return {
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
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Staff Performance Report
// ─────────────────────────────────────────────────────────────────────────────

export const getStaffPerformanceReport = async (
    userId: string,
    period: Period,
) => {
    const admin = await requireAdminProfile(userId);
    const adminId = admin.id;
    const { from, to } = resolvePeriod(period);

    // Load all jobs in period with staff assignments + reviews
    const jobs = await prisma.job.findMany({
        where: { adminId, scheduledDate: { gte: from, lte: to } },
        select: {
            id: true,
            status: true,
            durationMins: true,
            staffAssignments: {
                include: {
                    staff: {
                        include: {
                            user: {
                                select: { id: true, name: true, image: true },
                            },
                        },
                    },
                },
            },
            reviewToken: {
                include: {
                    reviews: {
                        where: { NOT: { staffId: null } },
                        select: { staffId: true, rating: true },
                    },
                },
            },
        },
    });

    // Build per-staff map
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

            // Attach ratings for this staff from the job's review token
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
                e.totalJobs > 0
                    ? Math.round((e.completed / e.totalJobs) * 100)
                    : 0,
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
                  (staffWithRatings.reduce(
                      (s, r) => s + (r.avgRating ?? 0),
                      0,
                  ) /
                      staffWithRatings.length) *
                      10,
              ) / 10
            : 0;

    return {
        stats: {
            totalStaff: staff.length,
            totalJobs,
            completedJobs,
            overallRate,
            overallRating,
        },
        staff,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Client Retention Report
// ─────────────────────────────────────────────────────────────────────────────

export const getClientRetentionReport = async (
    userId: string,
    period: Period,
) => {
    const admin = await requireAdminProfile(userId);
    const adminId = admin.id;
    const { from, to } = resolvePeriod(period);

    // All clients for this admin with booking stats
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

    // New clients acquired in period
    const newClients = clients.filter(
        (c) => c.createdAt >= from && c.createdAt <= to,
    );

    const repeat = clients.filter((c) => c.totalBookings > 1);
    const oneTime = clients.filter((c) => c.totalBookings <= 1);
    const churn = clients.filter((c) => c.status === "INACTIVE");

    const retentionRate =
        clients.length > 0
            ? Math.round((repeat.length / clients.length) * 100)
            : 0;
    const churnRate =
        clients.length > 0
            ? Math.round((churn.length / clients.length) * 100)
            : 0;

    // Average booking frequency for repeat clients
    const avgBookingFreq =
        repeat.length > 0
            ? Math.round(
                  (repeat.reduce((s, c) => s + c.totalBookings, 0) /
                      repeat.length) *
                      10,
              ) / 10
            : 0;

    // Top clients by spend
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

    // Acquisition over time — bucket new clients by period
    const acquisitionMap: Record<string, number> = {};
    for (const c of newClients) {
        const key = dateBucket(period, c.createdAt);
        acquisitionMap[key] = (acquisitionMap[key] ?? 0) + 1;
    }
    const acquisitionChart = Object.entries(acquisitionMap).map(
        ([label, count]) => ({
            label,
            count,
        }),
    );

    return {
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
        // Full client list (capped at 100 for the table)
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
};

export const reportsService = {
    getRevenueReport,
    getStaffPerformanceReport,
    getClientRetentionReport,
};
