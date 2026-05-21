import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  AccountStatus,
  SubscriptionStatus,
  UserRole,
} from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import { IPaginationOptions } from "../../interface/query.interface";
import { IActivityLogFilters, IAdminAccountFilters } from "./superAdmin.interface";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPagination(options: IPaginationOptions) {
  const page = Number(options.page) || 1;
  const limit = Number(options.limit) || 10;
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ─── Activity Logs ────────────────────────────────────────────────────────────

const getActivityLogs = async (
  filters: IActivityLogFilters,
  paginationOptions: IPaginationOptions,
) => {
  const { page, limit, skip } = buildPagination(paginationOptions);
  const { searchTerm, action, entityType, adminId, startDate, endDate } = filters;

  const where: Record<string, unknown> = {};

  if (adminId) {
    where.adminId = adminId;
  }

  if (action) {
    where.action = action;
  }

  if (entityType) {
    where.entityType = entityType;
  }

  if (startDate || endDate) {
    where.createdAt = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    };
  }

  if (searchTerm) {
    where.OR = [
      { description: { contains: searchTerm, mode: "insensitive" } },
      { entityId: { contains: searchTerm, mode: "insensitive" } },
      {
        admin: {
          user: {
            OR: [
              { name: { contains: searchTerm, mode: "insensitive" } },
              { email: { contains: searchTerm, mode: "insensitive" } },
            ],
          },
        },
      },
    ];
  }

  const [total, data] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      include: {
        admin: {
          include: {
            user: {
              select: { id: true, name: true, email: true, image: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data,
  };
};

const createActivityLog = async (data: {
  adminId: string;
  action: string;
  entityType: string;
  entityId?: string;
  description: string;
  metadata?: Record<string, unknown>;
}) => {
  return prisma.activityLog.create({ data });
};

const getActivityLogStats = async () => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());

  const [todayCount, weekCount, totalCount, byAction] = await Promise.all([
    prisma.activityLog.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.activityLog.count({ where: { createdAt: { gte: startOfWeek } } }),
    prisma.activityLog.count(),
    prisma.activityLog.groupBy({
      by: ["action"],
      _count: { _all: true },
      orderBy: { _count: { action: "desc" } },
      take: 10,
    }),
  ]);

  return {
    todayCount,
    weekCount,
    totalCount,
    topActions: byAction.map((a) => ({
      action: a.action,
      count: a._count._all,
    })),
  };
};

// ─── Revenue Dashboard ────────────────────────────────────────────────────────

const getPlatformRevenueDashboard = async (query: {
  startDate?: string;
  endDate?: string;
  interval?: "daily" | "weekly" | "monthly";
}) => {
  const { startDate, endDate, interval = "monthly" } = query;

  const dateFilter: Record<string, unknown> = {};
  if (startDate || endDate) {
    dateFilter.createdAt = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    };
  }

  // Core subscription counts
  const [
    activeSubscriptions,
    trialSubscriptions,
    cancelledSubscriptions,
    allSubscriptions,
    billingHistory,
    subscriptionsByPlan,
  ] = await Promise.all([
    prisma.subscription.count({
      where: { status: SubscriptionStatus.ACTIVE, isTrial: false },
    }),
    prisma.subscription.count({
      where: { status: SubscriptionStatus.ACTIVE, isTrial: true },
    }),
    prisma.subscription.count({
      where: { status: SubscriptionStatus.CANCELLED },
    }),
    // All active subscriptions with plan info for MRR
    prisma.subscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE, isTrial: false },
      include: { plan: true, subscriptionPlan: true },
    }),
    // Billing history for revenue timeline
    prisma.billingHistory.findMany({
      where: {
        status: "PAID",
        ...dateFilter,
      },
      include: {
        subscription: {
          include: {
            subscriptionPlan: { select: { name: true } },
            admin: {
              select: {
                businessName: true,
                user: { select: { name: true, email: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    // Revenue breakdown by plan
    prisma.subscription.groupBy({
      by: ["subscriptionPlanId"],
      where: { status: SubscriptionStatus.ACTIVE, isTrial: false },
      _count: { _all: true },
      _sum: { totalCost: true },
    }),
  ]);

  // Calculate MRR from active (non-trial) subscriptions
  const totalMRR = allSubscriptions.reduce((sum, sub) => {
    return sum + Number(sub.plan.price ?? 0);
  }, 0);

  // Total revenue from billing history
  const totalRevenue = billingHistory.reduce(
    (sum, bh) => sum + Number(bh.amount),
    0,
  );

  // Get plan names for breakdown
  const planIds = subscriptionsByPlan.map((s) => s.subscriptionPlanId);
  const plans = await prisma.subscriptionPlan.findMany({
    where: { id: { in: planIds } },
    select: { id: true, name: true },
  });
  const planMap = Object.fromEntries(plans.map((p) => [p.id, p.name]));

  const revenueByPlan = subscriptionsByPlan.map((row) => ({
    planName: planMap[row.subscriptionPlanId] ?? row.subscriptionPlanId,
    subscriberCount: row._count._all,
    totalRevenue: Number(row._sum.totalCost ?? 0),
  }));

  // Build revenue time series from billing history
  const revenueTimeline = buildTimeline(billingHistory, interval);

  // Recent billing transactions (for table)
  const recentTransactions = billingHistory.slice(0, 20).map((bh) => ({
    id: bh.id,
    amount: Number(bh.amount),
    currency: bh.currency,
    method: bh.method,
    status: bh.status,
    paidAt: bh.paidAt,
    createdAt: bh.createdAt,
    adminBusinessName: bh.subscription.admin?.businessName,
    adminName: bh.subscription.admin?.user?.name,
    adminEmail: bh.subscription.admin?.user?.email,
    planName: bh.subscription.subscriptionPlan?.name,
  }));

  return {
    summary: {
      totalMRR: parseFloat(totalMRR.toFixed(2)),
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      activeSubscriptions,
      trialSubscriptions,
      cancelledSubscriptions,
      totalSubscriptions: activeSubscriptions + trialSubscriptions + cancelledSubscriptions,
    },
    revenueByPlan,
    revenueTimeline,
    recentTransactions,
  };
};

function buildTimeline(
  billingHistory: { createdAt: Date; amount: unknown }[],
  interval: "daily" | "weekly" | "monthly",
) {
  const buckets = new Map<string, number>();

  billingHistory.forEach((bh) => {
    const d = new Date(bh.createdAt);
    let key: string;

    if (interval === "daily") {
      key = d.toISOString().split("T")[0]; // YYYY-MM-DD
    } else if (interval === "weekly") {
      const monday = new Date(d);
      monday.setDate(d.getDate() - d.getDay() + 1);
      key = monday.toISOString().split("T")[0];
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }

    buckets.set(key, (buckets.get(key) ?? 0) + Number(bh.amount));
  });

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, revenue]) => ({ period, revenue: parseFloat(revenue.toFixed(2)) }));
}

// ─── Admin Account Management ─────────────────────────────────────────────────

const getAllAdminAccounts = async (
  filters: IAdminAccountFilters,
  paginationOptions: IPaginationOptions,
) => {
  const { page, limit, skip } = buildPagination(paginationOptions);
  const { searchTerm, status: accountStatus, subscriptionStatus } = filters;

  const userWhere: Record<string, unknown> = {
    role: UserRole.ADMIN,
  };

  if (accountStatus) {
    userWhere.status = accountStatus;
  }

  if (searchTerm) {
    userWhere.OR = [
      { name: { contains: searchTerm, mode: "insensitive" } },
      { email: { contains: searchTerm, mode: "insensitive" } },
      {
        adminProfile: {
          businessName: { contains: searchTerm, mode: "insensitive" },
        },
      },
    ];
  }

  const [total, data] = await Promise.all([
    prisma.user.count({ where: userWhere }),
    prisma.user.findMany({
      where: userWhere,
      include: {
        adminProfile: {
          include: {
            subscription: {
              where: subscriptionStatus
                ? { status: subscriptionStatus as SubscriptionStatus }
                : {},
              include: {
                plan: true,
                subscriptionPlan: { select: { id: true, name: true } },
              },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
            _count: {
              select: { staff: true, clients: true, bookings: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data,
  };
};

const getAdminAccountById = async (adminId: string) => {
  const admin = await prisma.user.findFirst({
    where: { id: adminId, role: UserRole.ADMIN },
    include: {
      adminProfile: {
        include: {
          subscription: {
            include: {
              plan: true,
              subscriptionPlan: true,
              billingHistory: { orderBy: { createdAt: "desc" }, take: 10 },
            },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          _count: {
            select: {
              staff: true,
              clients: true,
              bookings: true,
              jobs: true,
              invoices: true,
            },
          },
        },
      },
    },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin account not found.");
  }

  return admin;
};

const suspendAdminAccount = async (adminId: string) => {
  const admin = await prisma.user.findFirst({
    where: { id: adminId, role: UserRole.ADMIN },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin account not found.");
  }

  return prisma.user.update({
    where: { id: adminId },
    data: { status: AccountStatus.SUSPENDED },
    select: { id: true, name: true, email: true, status: true },
  });
};

const activateAdminAccount = async (adminId: string) => {
  const admin = await prisma.user.findFirst({
    where: { id: adminId, role: UserRole.ADMIN },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin account not found.");
  }

  return prisma.user.update({
    where: { id: adminId },
    data: { status: AccountStatus.ACTIVE },
    select: { id: true, name: true, email: true, status: true },
  });
};

// ─── Platform Stats (for super admin overview dashboard) ──────────────────────

const getPlatformStats = async () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const [
    totalAdmins,
    activeAdmins,
    newAdminsThisMonth,
    activeSubscriptions,
    trialSubscriptions,
    allActiveSubs,
    newRevThisMonth,
    newRevLastMonth,
  ] = await Promise.all([
    prisma.user.count({ where: { role: UserRole.ADMIN } }),
    prisma.user.count({ where: { role: UserRole.ADMIN, status: AccountStatus.ACTIVE } }),
    prisma.user.count({
      where: { role: UserRole.ADMIN, createdAt: { gte: startOfMonth } },
    }),
    prisma.subscription.count({
      where: { status: SubscriptionStatus.ACTIVE, isTrial: false },
    }),
    prisma.subscription.count({
      where: { status: SubscriptionStatus.ACTIVE, isTrial: true },
    }),
    prisma.subscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE, isTrial: false },
      include: { plan: { select: { price: true } } },
    }),
    prisma.billingHistory.aggregate({
      where: { status: "PAID", createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.billingHistory.aggregate({
      where: {
        status: "PAID",
        createdAt: { gte: startOfLastMonth, lte: endOfLastMonth },
      },
      _sum: { amount: true },
    }),
  ]);

  const totalMRR = allActiveSubs.reduce(
    (sum, sub) => sum + Number(sub.plan.price ?? 0),
    0,
  );

  const thisMonthRevenue = Number(newRevThisMonth._sum.amount ?? 0);
  const lastMonthRevenue = Number(newRevLastMonth._sum.amount ?? 0);
  const revenueGrowthPct =
    lastMonthRevenue > 0
      ? parseFloat(
          (((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100).toFixed(1),
        )
      : 0;

  return {
    totalAdmins,
    activeAdmins,
    newAdminsThisMonth,
    activeSubscriptions,
    trialSubscriptions,
    totalMRR: parseFloat(totalMRR.toFixed(2)),
    thisMonthRevenue: parseFloat(thisMonthRevenue.toFixed(2)),
    lastMonthRevenue: parseFloat(lastMonthRevenue.toFixed(2)),
    revenueGrowthPct,
  };
};

// ─── Subscription Plan CRUD (extend existing stub) ────────────────────────────

const createSubscriptionPlan = async (payload: {
  name: string;
  description?: string;
  currency?: string;
  features: string[];
  plans: {
    interval: string;
    price: number;
    baseCharge?: number;
    pricePerStaff?: number;
    pricePerClient?: number;
    pricePerBooking?: number;
    maxStaff?: number;
    maxClient?: number;
    maxBookingsPerMonth?: number;
    discount?: number;
    discountEndDate?: string;
  }[];
}) => {
  const { plans, ...planData } = payload;

  return prisma.subscriptionPlan.create({
    data: {
      ...planData,
      plans: {
        create: plans.map((p) => ({
          interval: p.interval as never,
          price: p.price,
          baseCharge: p.baseCharge ?? 0,
          pricePerStaff: p.pricePerStaff ?? 0,
          pricePerClient: p.pricePerClient ?? 0,
          pricePerBooking: p.pricePerBooking ?? 0,
          maxStaff: p.maxStaff,
          maxClient: p.maxClient,
          maxBookingsPerMonth: p.maxBookingsPerMonth,
          discount: p.discount ?? 0,
          discountEndDate: p.discountEndDate
            ? new Date(p.discountEndDate)
            : undefined,
        })),
      },
    },
    include: { plans: true },
  });
};

const updateSubscriptionPlan = async (
  id: string,
  payload: {
    description?: string;
    features?: string[];
    currency?: string;
  },
) => {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
  if (!plan) {
    throw new AppError(status.NOT_FOUND, "Subscription plan not found.");
  }

  return prisma.subscriptionPlan.update({
    where: { id },
    data: payload,
    include: { plans: true },
  });
};

const updatePricingTier = async (
  planId: string,
  payload: {
    price?: number;
    baseCharge?: number;
    pricePerStaff?: number;
    pricePerClient?: number;
    pricePerBooking?: number;
    discount?: number;
    discountEndDate?: string | null;
    maxStaff?: number;
    maxClient?: number;
    maxBookingsPerMonth?: number;
  },
) => {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) {
    throw new AppError(status.NOT_FOUND, "Pricing tier not found.");
  }

  return prisma.plan.update({
    where: { id: planId },
    data: {
      ...payload,
      discountEndDate: payload.discountEndDate
        ? new Date(payload.discountEndDate)
        : payload.discountEndDate === null
          ? null
          : undefined,
    },
  });
};

const deleteSubscriptionPlan = async (id: string) => {
  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id },
    include: { _count: { select: { subscriptions: true } } },
  });
  if (!plan) {
    throw new AppError(status.NOT_FOUND, "Subscription plan not found.");
  }
  if (plan._count.subscriptions > 0) {
    throw new AppError(
      status.BAD_REQUEST,
      "Cannot delete a plan that has active subscribers.",
    );
  }

  return prisma.subscriptionPlan.delete({ where: { id } });
};

// ─── Admin Subscription Management (super admin actions) ─────────────────────

const getAllSubscriptions = async (
  filters: { status?: string; planId?: string; isTrial?: string },
  paginationOptions: IPaginationOptions,
) => {
  const { page, limit, skip } = buildPagination(paginationOptions);

  const where: Record<string, unknown> = {};
  if (filters.status) where.status = filters.status as SubscriptionStatus;
  if (filters.planId) where.planId = filters.planId;
  if (filters.isTrial !== undefined) where.isTrial = filters.isTrial === "true";

  const [total, data] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      include: {
        plan: true,
        subscriptionPlan: { select: { id: true, name: true } },
        admin: {
          select: {
            id: true,
            businessName: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
        billingHistory: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data,
  };
};

const cancelSubscription = async (subscriptionId: string) => {
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
  });
  if (!sub) {
    throw new AppError(status.NOT_FOUND, "Subscription not found.");
  }

  return prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      status: SubscriptionStatus.CANCELLED,
      canceledAt: new Date(),
    },
    include: { plan: true, subscriptionPlan: true },
  });
};

const getBillingHistory = async (
  filters: { adminId?: string; subscriptionId?: string; startDate?: string; endDate?: string },
  paginationOptions: IPaginationOptions,
) => {
  const { page, limit, skip } = buildPagination(paginationOptions);

  const where: Record<string, unknown> = {};
  if (filters.subscriptionId) where.subscriptionId = filters.subscriptionId;
  if (filters.startDate || filters.endDate) {
    where.createdAt = {
      ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
      ...(filters.endDate ? { lte: new Date(filters.endDate) } : {}),
    };
  }
  if (filters.adminId) {
    where.subscription = { adminId: filters.adminId };
  }

  const [total, data] = await Promise.all([
    prisma.billingHistory.count({ where }),
    prisma.billingHistory.findMany({
      where,
      include: {
        subscription: {
          include: {
            subscriptionPlan: { select: { name: true } },
            admin: {
              select: {
                businessName: true,
                user: { select: { name: true, email: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data,
  };
};

export const superAdminService = {
  // Activity logs
  getActivityLogs,
  createActivityLog,
  getActivityLogStats,
  // Revenue
  getPlatformRevenueDashboard,
  getPlatformStats,
  // Admin accounts
  getAllAdminAccounts,
  getAdminAccountById,
  suspendAdminAccount,
  activateAdminAccount,
  // Subscription plan CRUD
  createSubscriptionPlan,
  updateSubscriptionPlan,
  updatePricingTier,
  deleteSubscriptionPlan,
  // Subscription management
  getAllSubscriptions,
  cancelSubscription,
  getBillingHistory,
};
