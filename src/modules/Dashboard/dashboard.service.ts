import { prisma } from "../../lib/prisma/prisma";
import {
  BookingStatus,
  JobStatus,
  InvoiceStatus,
} from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import status from "http-status";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Get the AdminProfile id from a userId (throws if not found) */
const requireAdminProfile = async (userId: string) => {
  const admin = await prisma.adminProfile.findUnique({ where: { userId } });
  if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
  return admin;
};

/**
 * Build a { gte, lte } date range for the *previous* period of equal length,
 * used to calculate changePercent relative to last period.
 */
const previousPeriod = (from: Date, to: Date) => {
  const ms = to.getTime() - from.getTime();
  return { gte: new Date(from.getTime() - ms), lte: new Date(from.getTime()) };
};

/** Safe percent change — avoids divide-by-zero */
const pct = (current: number, previous: number) =>
  previous === 0 ? 0 : Math.round(((current - previous) / previous) * 100);

// ─── Dashboard Overview ───────────────────────────────────────────────────────

const getDashboardOverview = async (userId: string) => {
  const admin = await requireAdminProfile(userId);
  const adminId = admin.id;

  // Current period = last 30 days
  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setDate(now.getDate() - 30);

  const prev = previousPeriod(periodStart, now);

  // ── Run all queries in parallel ──────────────────────────────────────────
  const [
    // Stats — current period
    invoicesCurrentRaw,
    activeBookingsCount,
    totalClientsCount,
    jobsCompletedCount,

    // Stats — previous period (for changePercent)
    invoicesPrevRaw,
    activeBookingsPrevCount,
    clientsPrevCount,
    jobsCompletedPrevCount,

    // Revenue insight — last 7 days
    recentInvoices,

    // Recent bookings — last 5
    recentBookingsRaw,

    // Top staff — by completed jobs (last 90 days)
    topStaffRaw,
  ] = await Promise.all([
    // Current revenue (PAID invoices in last 30 days)
    prisma.invoice.aggregate({
      where: {
        adminId,
        status: InvoiceStatus.PAID,
        paidDate: { gte: periodStart, lte: now },
      },
      _sum: { total: true },
    }),

    // Active bookings right now
    prisma.booking.count({
      where: {
        adminId,
        status: { in: [BookingStatus.SCHEDULED, BookingStatus.IN_PROGRESS] },
      },
    }),

    // Total clients ever
    prisma.client.count({ where: { adminId } }),

    // Jobs completed this period
    prisma.job.count({
      where: {
        adminId,
        status: JobStatus.COMPLETED,
        updatedAt: { gte: periodStart, lte: now },
      },
    }),

    // Previous revenue
    prisma.invoice.aggregate({
      where: { adminId, status: InvoiceStatus.PAID, paidDate: prev },
      _sum: { total: true },
    }),

    // Previous active bookings (snapshot approximation: bookings scheduled in prev period)
    prisma.booking.count({
      where: {
        adminId,
        status: { in: [BookingStatus.SCHEDULED, BookingStatus.IN_PROGRESS] },
        createdAt: prev,
      },
    }),

    // Clients created before periodStart (previous baseline)
    prisma.client.count({
      where: { adminId, createdAt: { lte: periodStart } },
    }),

    // Jobs completed in previous period
    prisma.job.count({
      where: { adminId, status: JobStatus.COMPLETED, updatedAt: prev },
    }),

    // Paid invoices from last 7 days grouped by day (for revenue insight chart)
    prisma.invoice.findMany({
      where: {
        adminId,
        status: InvoiceStatus.PAID,
        paidDate: {
          gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
          lte: now,
        },
      },
      select: { paidDate: true, total: true },
    }),

    // Most recent 5 bookings with client + staff
    prisma.booking.findMany({
      where: { adminId },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        client: { select: { id: true, name: true, profilePhoto: true } },
        staffAssignments: {
          include: {
            staff: {
              include: { user: { select: { name: true } } },
            },
          },
          take: 1, // first assigned staff name for the overview card
        },
      },
    }),

    // Top 4 staff by completed job count in last 90 days
    prisma.staffProfile.findMany({
      where: { adminId },
      include: {
        user: { select: { id: true, name: true, image: true } },
        jobAssignments: {
          where: {
            job: {
              status: JobStatus.COMPLETED,
              updatedAt: {
                gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
              },
            },
          },
          include: { job: { select: { status: true } } },
        },
      },
    }),
  ]);

  // ── Build stats ──────────────────────────────────────────────────────────
  const currentRevenue = Number(invoicesCurrentRaw._sum.total ?? 0);
  const previousRevenue = Number(invoicesPrevRaw._sum.total ?? 0);

  const stats = [
    {
      label: "Total Revenue",
      value: currentRevenue,
      changePercent: pct(currentRevenue, previousRevenue),
      prefix: admin.currency === "USD" ? "$" : admin.currency,
    },
    {
      label: "Active Bookings",
      value: activeBookingsCount,
      changePercent: pct(activeBookingsCount, activeBookingsPrevCount),
    },
    {
      label: "Total Clients",
      value: totalClientsCount,
      changePercent: pct(totalClientsCount, clientsPrevCount),
    },
    {
      label: "Jobs Completed",
      value: jobsCompletedCount,
      changePercent: pct(jobsCompletedCount, jobsCompletedPrevCount),
    },
  ];

  // ── Build revenue insight (last 7 days, one entry per day) ───────────────
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const revenueByDay: Record<
    string,
    { revenue: number; jobsCompleted: number; newClients: number }
  > = {};

  // Pre-fill 7 days
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = DAYS[d.getDay()];
    revenueByDay[key] = { revenue: 0, jobsCompleted: 0, newClients: 0 };
  }

  for (const inv of recentInvoices) {
    if (!inv.paidDate) continue;
    const key = DAYS[inv.paidDate.getDay()];
    if (revenueByDay[key]) {
      revenueByDay[key].revenue += Number(inv.total);
    }
  }

  // Jobs completed per day (last 7)
  const recentJobsByDay = await prisma.job.groupBy({
    by: ["updatedAt"],
    where: {
      adminId,
      status: JobStatus.COMPLETED,
      updatedAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    },
    _count: true,
  });

  for (const row of recentJobsByDay) {
    const key = DAYS[new Date(row.updatedAt).getDay()];
    if (revenueByDay[key]) {
      revenueByDay[key].jobsCompleted += row._count;
    }
  }

  // New clients per day (last 7)
  const recentClientsByDay = await prisma.client.groupBy({
    by: ["createdAt"],
    where: {
      adminId,
      createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    },
    _count: true,
  });

  for (const row of recentClientsByDay) {
    const key = DAYS[new Date(row.createdAt).getDay()];
    if (revenueByDay[key]) {
      revenueByDay[key].newClients += row._count;
    }
  }

  const revenueInsight = Object.entries(revenueByDay).map(([day, data]) => ({
    day,
    ...data,
  }));

  // ── Shape recent bookings ────────────────────────────────────────────────
  const recentBookings = recentBookingsRaw.map((b) => {
    const firstStaff = b.staffAssignments[0]?.staff?.user?.name ?? null;
    return {
      id: b.id,
      bookingRef: b.bookingRef,
      clientName: b.client.name,
      clientAvatar: b.client.profilePhoto ?? undefined,
      serviceType: b.serviceType,
      scheduledDate: b.scheduledDate.toISOString(),
      address: b.address,
      assignedStaff: firstStaff ?? "Unassigned",
      status: b.status,
      total: Number(b.total),
    };
  });

  // ── Shape top staff ──────────────────────────────────────────────────────
  const sortedStaff = topStaffRaw
    .map((s) => ({
      id: s.user.id,
      name: s.user.name,
      avatar: s.user.image ?? undefined,
      jobsCompleted: s.jobAssignments.length,
      // Specialty from the staff profile array (take first if set)
      speciality: (s.specialty[0] ?? "Residential Clean") as string,
      // Rating placeholder — will be real once Review model is fixed (Phase 4)
      rating: 0,
    }))
    .sort((a, b) => b.jobsCompleted - a.jobsCompleted)
    .slice(0, 4);

  return { stats, revenueInsight, recentBookings, topStaff: sortedStaff };
};

// ─── Revenue Page ─────────────────────────────────────────────────────────────

type RevenuePeriod = "7d" | "30d" | "90d" | "12m";

const getRevenuePage = async (userId: string, period: RevenuePeriod) => {
  const admin = await requireAdminProfile(userId);
  const adminId = admin.id;
  const now = new Date();

  // Resolve period boundaries
  const msPerDay = 24 * 60 * 60 * 1000;
  let from: Date;
  let bucketFn: (d: Date) => string;

  if (period === "7d") {
    from = new Date(now.getTime() - 7 * msPerDay);
    bucketFn = (d) =>
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  } else if (period === "30d") {
    from = new Date(now.getTime() - 30 * msPerDay);
    bucketFn = (d) => {
      const w = Math.ceil(d.getDate() / 7);
      return `Week ${w}`;
    };
  } else if (period === "90d") {
    from = new Date(now.getTime() - 90 * msPerDay);
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
    bucketFn = (d) => monthNames[d.getMonth()];
  } else {
    // 12m
    from = new Date(now);
    from.setFullYear(from.getFullYear() - 1);
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
    bucketFn = (d) => monthNames[d.getMonth()];
  }

  const prev = previousPeriod(from, now);

  const [
    paidInvoicesCurrent,
    paidInvoicesPrev,
    expensesCurrent,
    expensesPrev,
    outstandingRaw,
    allPaidInvoices,
    allExpenses,
    recentInvoicesFull,
    staffWithJobs,
  ] = await Promise.all([
    // Total paid revenue this period
    prisma.invoice.aggregate({
      where: {
        adminId,
        status: InvoiceStatus.PAID,
        paidDate: { gte: from, lte: now },
      },
      _sum: { total: true },
    }),
    // Total paid revenue prev period
    prisma.invoice.aggregate({
      where: { adminId, status: InvoiceStatus.PAID, paidDate: prev },
      _sum: { total: true },
    }),
    // Total expenses this period
    prisma.expense.aggregate({
      where: { adminId, date: { gte: from, lte: now } },
      _sum: { amount: true },
    }),
    // Total expenses prev period
    prisma.expense.aggregate({
      where: { adminId, date: prev },
      _sum: { amount: true },
    }),
    // Outstanding invoices (SENT + OVERDUE)
    prisma.invoice.aggregate({
      where: {
        adminId,
        status: { in: [InvoiceStatus.SENT, InvoiceStatus.OVERDUE] },
      },
      _sum: { total: true },
    }),
    // Paid invoices for chart bucketing
    prisma.invoice.findMany({
      where: {
        adminId,
        status: InvoiceStatus.PAID,
        paidDate: { gte: from, lte: now },
      },
      select: { paidDate: true, total: true, serviceType: true },
    }),
    // Expenses for chart bucketing
    prisma.expense.findMany({
      where: { adminId, date: { gte: from, lte: now } },
      select: { date: true, amount: true },
    }),
    // Recent 8 invoices with booking context for transactions table
    prisma.invoice.findMany({
      where: { adminId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        invoiceRef: true,
        clientName: true,
        serviceType: true,
        issuedDate: true,
        total: true,
        status: true,
      },
    }),
    // Staff with completed job assignments (for byStaff)
    prisma.staffProfile.findMany({
      where: { adminId },
      include: {
        user: { select: { id: true, name: true, image: true } },
        jobAssignments: {
          where: {
            job: {
              status: JobStatus.COMPLETED,
              updatedAt: { gte: from, lte: now },
            },
          },
          include: {
            job: { select: { total: true } },
          },
        },
      },
    }),
  ]);

  const totalRevenue = Number(paidInvoicesCurrent._sum.total ?? 0);
  const prevRevenue = Number(paidInvoicesPrev._sum.total ?? 0);
  const totalExpenses = Number(expensesCurrent._sum.amount ?? 0);
  const prevExpenses = Number(expensesPrev._sum.amount ?? 0);
  const totalProfit = totalRevenue - totalExpenses;
  const prevProfit = prevRevenue - prevExpenses;
  const outstanding = Number(outstandingRaw._sum.total ?? 0);
  const prevOutstanding = 0; // no prev snapshot for outstanding; treat as neutral

  const jobCountCurrent = await prisma.job.count({
    where: {
      adminId,
      status: JobStatus.COMPLETED,
      updatedAt: { gte: from, lte: now },
    },
  });

  // ── Chart: bucket by period ──────────────────────────────────────────────
  const chartMap: Record<string, { revenue: number; expenses: number }> = {};

  for (const inv of allPaidInvoices) {
    if (!inv.paidDate) continue;
    const key = bucketFn(inv.paidDate);
    if (!chartMap[key]) chartMap[key] = { revenue: 0, expenses: 0 };
    chartMap[key].revenue += Number(inv.total);
  }
  for (const exp of allExpenses) {
    const key = bucketFn(exp.date);
    if (!chartMap[key]) chartMap[key] = { revenue: 0, expenses: 0 };
    chartMap[key].expenses += Number(exp.amount);
  }

  const chart = Object.entries(chartMap).map(([label, d]) => ({
    label,
    revenue: d.revenue,
    expenses: d.expenses,
    profit: d.revenue - d.expenses,
  }));

  // ── By service ───────────────────────────────────────────────────────────
  const serviceMap: Record<string, { revenue: number; jobs: number }> = {};
  for (const inv of allPaidInvoices) {
    const key = inv.serviceType ?? "Other";
    if (!serviceMap[key]) serviceMap[key] = { revenue: 0, jobs: 0 };
    serviceMap[key].revenue += Number(inv.total);
    serviceMap[key].jobs += 1;
  }

  const byService = Object.entries(serviceMap).map(([serviceType, d]) => ({
    serviceType,
    revenue: d.revenue,
    jobs: d.jobs,
    avgPerJob: d.jobs > 0 ? Math.round(d.revenue / d.jobs) : 0,
    changePercent: 0, // requires prev-period per-service split — leave 0 until review is done
  }));

  // ── By staff ─────────────────────────────────────────────────────────────
  const byStaff = staffWithJobs
    .map((s) => {
      const revenue = s.jobAssignments.reduce(
        (sum, a) => sum + Number((a.job as any)?.total ?? 0),
        0,
      );
      return {
        staffId: s.user.id,
        name: s.user.name,
        avatar: s.user.image ?? undefined,
        revenue,
        jobs: s.jobAssignments.length,
        avgRating: 0, // real value once Review model is fixed (Phase 4)
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // ── Recent transactions ──────────────────────────────────────────────────
  const statusMap: Record<string, "Paid" | "Pending" | "Overdue"> = {
    PAID: "Paid",
    SENT: "Pending",
    OVERDUE: "Overdue",
    DRAFT: "Pending",
    CANCELLED: "Pending",
  };

  const recentTransactions = recentInvoicesFull.map((inv) => ({
    id: inv.id,
    bookingRef: inv.invoiceRef,
    clientName: inv.clientName,
    serviceType: inv.serviceType ?? "Other",
    date: inv.issuedDate.toISOString(),
    amount: Number(inv.total),
    status: statusMap[inv.status] ?? "Pending",
  }));

  return {
    stats: {
      totalRevenue: {
        label: "Total Revenue",
        value: totalRevenue,
        changePercent: pct(totalRevenue, prevRevenue),
        prefix: "$",
      },
      totalProfit: {
        label: "Net Profit",
        value: totalProfit,
        changePercent: pct(totalProfit, prevProfit),
        prefix: "$",
      },
      avgJobValue: {
        label: "Avg. Job Value",
        value:
          jobCountCurrent > 0 ? Math.round(totalRevenue / jobCountCurrent) : 0,
        changePercent: 0,
        prefix: "$",
      },
      outstandingInvoices: {
        label: "Outstanding Invoices",
        value: outstanding,
        changePercent: pct(outstanding, prevOutstanding),
        prefix: "$",
      },
    },
    chart,
    byService,
    byStaff,
    recentTransactions,
  };
};

export const dashboardService = {
  getDashboardOverview,
  getRevenuePage,
};
