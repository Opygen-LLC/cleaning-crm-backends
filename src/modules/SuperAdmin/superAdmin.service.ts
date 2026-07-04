import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
    AccountStatus,
    SubscriptionStatus,
    UserRole,
} from "../../generated/prisma/enums";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { IPaginationOptions } from "../../interface/query.interface";
import {
    IActivityLogFilters,
    IAdminAccountFilters,
} from "./superAdmin.interface";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { waitUntil } from "@vercel/functions";
import { auth } from "../../lib/auth";
import { adminService } from "../Admin/admin.service";
import { createNotification } from "../../lib/utils/createNotification";
import { NotificationType } from "../../generated/prisma/enums";
import {
    getPlatformConfig as sharedGetPlatformConfig,
    updatePlatformConfig as sharedUpdatePlatformConfig,
} from "../../lib/utils/platformConfig";
import { findNearMissFeatureLabels } from "../../lib/constants/featureGateLabels";

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
    const { searchTerm, action, entityType, adminId, startDate, endDate } =
        filters;

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
                            {
                                name: {
                                    contains: searchTerm,
                                    mode: "insensitive",
                                },
                            },
                            {
                                email: {
                                    contains: searchTerm,
                                    mode: "insensitive",
                                },
                            },
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
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                image: true,
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
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
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
    return prisma.activityLog.create({
        data: {
            ...data,
            metadata: data.metadata as Prisma.InputJsonValue | undefined,
        },
    });
};

const getActivityLogStats = async () => {
    const now = new Date();
    const startOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
    );
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());

    const [todayCount, weekCount, totalCount, byAction] = await Promise.all([
        prisma.activityLog.count({ where: { createdAt: { gte: startOfDay } } }),
        prisma.activityLog.count({
            where: { createdAt: { gte: startOfWeek } },
        }),
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
            totalSubscriptions:
                activeSubscriptions +
                trialSubscriptions +
                cancelledSubscriptions,
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
        .map(([period, revenue]) => ({
            period,
            revenue: parseFloat(revenue.toFixed(2)),
        }));
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
                admin: {
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
                admin: {
                    include: {
                        subscription: {
                            where: subscriptionStatus
                                ? {
                                      status: subscriptionStatus as SubscriptionStatus,
                                  }
                                : {},
                            include: {
                                plan: true,
                                subscriptionPlan: {
                                    select: { id: true, name: true },
                                },
                            },
                            orderBy: { createdAt: "desc" },
                            take: 1,
                        },
                        _count: {
                            select: {
                                staff: true,
                                clients: true,
                                bookings: true,
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
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        data,
    };
};

const getAdminAccountById = async (adminId: string) => {
    const admin = await prisma.user.findFirst({
        where: { id: adminId, role: UserRole.ADMIN },
        include: {
            admin: {
                include: {
                    subscription: {
                        include: {
                            plan: true,
                            subscriptionPlan: true,
                            billingHistory: {
                                orderBy: { createdAt: "desc" },
                                take: 10,
                            },
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

// ─── Create admin account (super-admin dedicated endpoint) ────────────────────
// Bypasses email verification: account is set ACTIVE immediately.
// Sends a welcome email with credentials when sendWelcomeEmail === true.

const createAdminAccount = async (payload: {
    name: string;
    email: string;
    password: string;
    businessName: string;
    sendWelcomeEmail?: boolean;
}) => {
    const {
        name,
        email,
        password,
        businessName,
        sendWelcomeEmail = true,
    } = payload;

    if (!name || !email || !password || !businessName) {
        throw new AppError(
            status.BAD_REQUEST,
            "name, email, password, and businessName are required.",
        );
    }

    // Check for existing user
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        throw new AppError(
            status.CONFLICT,
            `An account with email ${email} already exists.`,
        );
    }

    const data = await auth.api
        .signUpEmail({
            body: {
                name,
                email,
                password,
            },
        })
        .catch((err) => {
            if (err?.body?.code === "USER_ALREADY_EXISTS") {
                throw new AppError(status.BAD_REQUEST, "User already exists.");
            }

            throw err;
        });

    if (!data.user?.id) {
        throw new AppError(status.BAD_REQUEST, "Failed to register user.");
    }

    try {
        const user = await prisma.user.update({
            where: {
                id: data.user.id,
            },
            data: {
                role: UserRole.ADMIN,
                status: AccountStatus.ACTIVE,
                emailVerified: true,
            },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                createdAt: true,
            },
        });

        const admin = await adminService.createAdmin({
            userId: data.user.id,
            businessName,
        });

        // Fire-and-forget welcome email with login credentials
        if (sendWelcomeEmail) {
            waitUntil(
                sendEmailSafely({
                    to: email,
                    subject: "Your Opygen CleanCRM Admin Account is Ready",
                    templateName: "admin-created",
                    templateData: {
                        name,
                        email,
                        password,
                        businessName,
                        loginUrl: `${process.env.FRONTEND_URL ?? "https://app.opygen.io"}/login`,
                    },
                }),
            );
        }

        return {
            ...user,
            admin,
        };
    } catch (error) {
        // Rollback
        await prisma.user
            .delete({
                where: {
                    id: data.user.id,
                },
            })
            .catch(() => {});

        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Registration failed. Please try again.",
        );
    }
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
        prisma.user.count({
            where: { role: UserRole.ADMIN, status: AccountStatus.ACTIVE },
        }),
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
                  (
                      ((thisMonthRevenue - lastMonthRevenue) /
                          lastMonthRevenue) *
                      100
                  ).toFixed(1),
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

    if (planData.features?.length) {
        const nearMisses = findNearMissFeatureLabels(planData.features);
        if (nearMisses.length > 0) {
            throw new AppError(
                status.BAD_REQUEST,
                `Feature label(s) look like typos of a known gate string: ${nearMisses
                    .map(
                        (w) =>
                            `"${w.submitted}" (did you mean "${w.closestCanonical}"?)`,
                    )
                    .join(
                        "; ",
                    )}. Use the exact canonical label, or pick it from the plan editor's checklist.`,
            );
        }
    }

    return prisma.subscriptionPlan.create({
        data: {
            name: planData.name as import("../../generated/prisma/enums").SubscriptionName,
            description: planData.description,
            currency: planData.currency as
                | import("../../generated/prisma/enums").Currency
                | undefined,
            features: planData.features,
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

    if (payload.features?.length) {
        const nearMisses = findNearMissFeatureLabels(payload.features);
        if (nearMisses.length > 0) {
            throw new AppError(
                status.BAD_REQUEST,
                `Feature label(s) look like typos of a known gate string: ${nearMisses
                    .map(
                        (w) =>
                            `"${w.submitted}" (did you mean "${w.closestCanonical}"?)`,
                    )
                    .join(
                        "; ",
                    )}. Use the exact canonical label, or pick it from the plan editor's checklist.`,
            );
        }
    }

    return prisma.subscriptionPlan.update({
        where: { id },
        data: {
            description: payload.description,
            features: payload.features,
            currency: payload.currency as
                | import("../../generated/prisma/enums").Currency
                | undefined,
        },
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

// ─── Toggle subscription plan active/inactive ─────────────────────────────────
// `isActive` is a real Boolean column on SubscriptionPlan (added via migration
// 20260623_subscription_plan_is_active).  The frontend maps it to the
// "Active" / "Inactive" display status.
const toggleSubscriptionPlanStatus = async (id: string, isActive: boolean) => {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!plan) {
        throw new AppError(status.NOT_FOUND, "Subscription plan not found.");
    }

    return prisma.subscriptionPlan.update({
        where: { id },
        data: { isActive },
        include: { plans: true },
    });
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
    if (filters.isTrial !== undefined)
        where.isTrial = filters.isTrial === "true";

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
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
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
    filters: {
        adminId?: string;
        subscriptionId?: string;
        startDate?: string;
        endDate?: string;
    },
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
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        data,
    };
};

const grantManualPayment = async (
    subscriptionId: string,
    payload: {
        amount: number;
        method: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "MANUAL";
        note?: string;
        transactionId?: string;
        periodMonths?: number;
    },
) => {
    const { amount, method, note, transactionId, periodMonths = 1 } = payload;

    const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
    });
    if (!sub) {
        throw new AppError(status.NOT_FOUND, "Subscription not found.");
    }

    // Extend from today if currentPeriodEnd has already passed, otherwise extend from its current value
    const baseDate =
        sub.currentPeriodEnd && sub.currentPeriodEnd > new Date()
            ? new Date(sub.currentPeriodEnd)
            : new Date();

    const nextPeriodEnd = new Date(baseDate);
    nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + periodMonths);

    const [billingRecord, updatedSub] = await prisma.$transaction([
        prisma.billingHistory.create({
            data: {
                subscriptionId,
                amount,
                currency: "USD",
                method,
                status: "PAID",
                note: note ?? null,
                transactionId: transactionId ?? null,
                paidAt: new Date(),
            },
        }),
        prisma.subscription.update({
            where: { id: subscriptionId },
            data: {
                status: SubscriptionStatus.ACTIVE,
                isTrial: false,
                currentPeriodStart: new Date(),
                currentPeriodEnd: nextPeriodEnd,
                cancelAtPeriodEnd: false,
                canceledAt: null,
            },
            include: { plan: true, subscriptionPlan: true },
        }),
    ]);

    return { billingRecord, subscription: updatedSub };
};

const suspendSubscription = async (subscriptionId: string) => {
    const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
    });
    if (!sub) {
        throw new AppError(status.NOT_FOUND, "Subscription not found.");
    }
    if (sub.status === SubscriptionStatus.SUSPENDED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Subscription is already suspended.",
        );
    }

    return prisma.subscription.update({
        where: { id: subscriptionId },
        data: { status: SubscriptionStatus.SUSPENDED },
        include: { plan: true, subscriptionPlan: true },
    });
};

const reactivateSubscription = async (subscriptionId: string) => {
    const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
    });
    if (!sub) {
        throw new AppError(status.NOT_FOUND, "Subscription not found.");
    }
    if (sub.status === SubscriptionStatus.ACTIVE) {
        throw new AppError(
            status.BAD_REQUEST,
            "Subscription is already active.",
        );
    }

    return prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
            status: SubscriptionStatus.ACTIVE,
            cancelAtPeriodEnd: false,
            canceledAt: null,
        },
        include: { plan: true, subscriptionPlan: true },
    });
};

const extendTrial = async (subscriptionId: string, days: number) => {
    if (!days || days < 1 || days > 365) {
        throw new AppError(
            status.BAD_REQUEST,
            "days must be between 1 and 365.",
        );
    }

    const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
    });
    if (!sub) {
        throw new AppError(status.NOT_FOUND, "Subscription not found.");
    }
    if (!sub.isTrial) {
        throw new AppError(
            status.BAD_REQUEST,
            "Subscription is not a trial — use grant-payment to extend a paid period.",
        );
    }

    const msToAdd = days * 24 * 60 * 60 * 1000;

    // Extend from current trialEndsAt if set, otherwise from now
    const trialBase = sub.trialEndsAt ?? new Date();
    const newTrialEnd = new Date(trialBase.getTime() + msToAdd);

    // Extend currentPeriodEnd by the same amount
    const periodBase = sub.currentPeriodEnd ?? new Date();
    const newPeriodEnd = new Date(periodBase.getTime() + msToAdd);

    return prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
            trialEndsAt: newTrialEnd,
            currentPeriodEnd: newPeriodEnd,
            // Restore ACTIVE if the trial had expired
            status: SubscriptionStatus.ACTIVE,
        },
        include: { plan: true, subscriptionPlan: true },
    });
};

// ─── Platform Config (item 15) ───────────────────────────────────────────────
// Persisted as a single JSON blob in the SuperAdminConfig table.
// Falls back to safe defaults when no row exists yet.

// ─── Platform Configuration ───────────────────────────────────────────────────
// Implementation lives in lib/utils/platformConfig.ts so other modules
// (subscription trial creation, registration gating, maintenance-mode
// middleware) can read it without importing the whole SuperAdmin service.

const getPlatformConfig = sharedGetPlatformConfig;
const updatePlatformConfig = sharedUpdatePlatformConfig;

// ─── Trial Nudge Email (item 16) ─────────────────────────────────────────────
// Sends a plain-text trial-expiry reminder to the admin email.
// Uses sendEmailSafely so a failed SMTP call never crashes the request.

const sendTrialNudge = async (subscriptionId: string) => {
    const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: {
            admin: {
                include: { user: { select: { name: true, email: true } } },
                select: { businessName: true, user: true },
            },
            subscriptionPlan: { select: { name: true } },
        },
    });

    if (!sub) throw new AppError(status.NOT_FOUND, "Subscription not found.");
    if (!sub.isTrial)
        throw new AppError(status.BAD_REQUEST, "Subscription is not a trial.");

    const adminEmail = sub.admin?.user?.email;
    const adminName = sub.admin?.user?.name ?? "there";
    const planName = sub.subscriptionPlan?.name ?? "your plan";

    const trialEnd = sub.trialEndsAt ?? sub.currentPeriodEnd;
    const daysLeft = trialEnd
        ? Math.max(
              0,
              Math.ceil(
                  (new Date(trialEnd).getTime() - Date.now()) / 86_400_000,
              ),
          )
        : 0;

    if (!adminEmail)
        throw new AppError(status.BAD_REQUEST, "Admin has no email address.");

    // Fire-and-forget — the await is just to surface SMTP errors in logs
    await sendEmailSafely({
        to: adminEmail,
        subject: `Your ${planName} trial ends in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`,
        templateName: "trial-nudge",
        templateData: {
            adminName,
            planName,
            daysLeft,
            trialEnd: trialEnd
                ? new Date(trialEnd).toLocaleDateString("en-GB")
                : "soon",
        },
    });

    return { sent: true, to: adminEmail, daysLeft };
};

/**
 * PATCH /super-admin/billing-history/:id/refund
 *
 * Actions:
 *   1. BillingHistory status → REFUNDED
 *   2. If the subscription this record funded is currently ACTIVE, it is
 *      moved to SUSPENDED — the tenant paid, got refunded, and should not
 *      keep paid access. (If the subscription is already CANCELLED/EXPIRED/
 *      SUSPENDED, or another later PAID record has taken over funding the
 *      current period, we leave its status untouched.)
 *   3. Tenant admin is notified in real time.
 *
 * NOTE: previously this only flipped the billing row to REFUNDED and never
 * touched the subscription at all, so a refunded tenant kept full paid
 * access indefinitely — that was the actual bug here.
 */
const refundBillingRecord = async (id: string) => {
    const record = await prisma.billingHistory.findUnique({
        where: { id },
        include: { subscription: true },
    });
    if (!record) {
        throw new AppError(status.NOT_FOUND, "Billing record not found.");
    }
    if (record.status === "REFUNDED") {
        throw new AppError(
            status.BAD_REQUEST,
            "This record has already been refunded.",
        );
    }

    const sub = record.subscription;
    const shouldSuspend =
        record.status === "PAID" && sub.status === SubscriptionStatus.ACTIVE;

    const [updatedBilling] = await prisma.$transaction([
        prisma.billingHistory.update({
            where: { id },
            data: { status: "REFUNDED" },
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
        }),
        ...(shouldSuspend
            ? [
                  prisma.subscription.update({
                      where: { id: sub.id },
                      data: { status: SubscriptionStatus.SUSPENDED },
                  }),
              ]
            : []),
    ]);

    createNotification({
        adminId: sub.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Payment refunded",
        message: shouldSuspend
            ? "A payment on your account was refunded and your subscription has been suspended. Contact support to reactivate."
            : "A payment on your account has been refunded.",
        relatedId: record.id,
    }).catch(() => {});

    return updatedBilling;
};

// ─── Billing History — Invoice URL (item 14) ──────────────────────────────────
// Returns the Cloudinary invoiceUrl stored on the record, or a structured
// placeholder so the frontend always gets a usable response.

const getBillingInvoice = async (id: string) => {
    const record = await prisma.billingHistory.findUnique({
        where: { id },
        select: {
            id: true,
            invoiceUrl: true,
            amount: true,
            currency: true,
            paidAt: true,
            createdAt: true,
        },
    });
    if (!record) {
        throw new AppError(status.NOT_FOUND, "Billing record not found.");
    }

    return {
        id: record.id,
        invoiceUrl: record.invoiceUrl ?? null,
        amount: Number(record.amount),
        currency: record.currency,
        paidAt: record.paidAt,
        createdAt: record.createdAt,
    };
};

// ─── Payment Proof Review (manual payment loop) ───────────────────────────────

/**
 * GET /super-admin/billing-history/pending-proofs
 * Returns every BillingHistory row that:
 *   - has a paymentProofUrl (tenant uploaded evidence)
 *   - has status PENDING  (not yet approved / rejected)
 * Ordered oldest-first so the super admin clears the queue in FIFO order.
 */
const getPendingProofs = async (options: IPaginationOptions) => {
    const { page, limit, skip } = buildPagination(options);

    const where: Prisma.BillingHistoryWhereInput = {
        status: "PENDING",
        paymentProofUrl: { not: null },
    };

    const [total, data] = await Promise.all([
        prisma.billingHistory.count({ where }),
        prisma.billingHistory.findMany({
            where,
            orderBy: { createdAt: "asc" },
            skip,
            take: limit,
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
        }),
    ]);

    return {
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        data,
    };
};

/**
 * PATCH /super-admin/billing-history/:id/approve-proof
 * Super admin has reviewed the proof and confirms payment.
 *
 * Actions:
 *   1. BillingHistory status → PAID, paidAt → now()
 *   2. Subscription status  → ACTIVE, period advanced by periodMonths (default 1)
 *   3. Subscription.isTrial → false
 */
const approvePaymentProof = async (
    billingId: string,
    payload: { periodMonths?: number; note?: string },
) => {
    const { periodMonths = 1, note } = payload;

    const record = await prisma.billingHistory.findUnique({
        where: { id: billingId },
        include: { subscription: true },
    });
    if (!record) {
        throw new AppError(status.NOT_FOUND, "Billing record not found.");
    }
    if (record.status !== "PENDING") {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot approve a proof with status "${record.status}". Only PENDING proofs can be approved.`,
        );
    }
    if (!record.paymentProofUrl) {
        throw new AppError(
            status.BAD_REQUEST,
            "This billing record has no attached payment proof.",
        );
    }

    const sub = record.subscription;

    // Extend from today if the current period has already lapsed
    const baseDate =
        sub.currentPeriodEnd && sub.currentPeriodEnd > new Date()
            ? new Date(sub.currentPeriodEnd)
            : new Date();

    const nextPeriodEnd = new Date(baseDate);
    nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + periodMonths);

    const [updatedBilling, updatedSub] = await prisma.$transaction([
        prisma.billingHistory.update({
            where: { id: billingId },
            data: {
                status: "PAID",
                paidAt: new Date(),
                note: note ?? record.note,
            },
        }),
        prisma.subscription.update({
            where: { id: sub.id },
            data: {
                status: SubscriptionStatus.ACTIVE,
                isTrial: false,
                currentPeriodStart: new Date(),
                currentPeriodEnd: nextPeriodEnd,
                cancelAtPeriodEnd: false,
                canceledAt: null,
            },
            include: { plan: true, subscriptionPlan: true },
        }),
    ]);

    // Notify the tenant admin in real time (persists + pushes over Socket.IO)
    // so their subscription status / feature gates update without a re-login.
    // The frontend's notification:new handler invalidates the "subscriptions"
    // RTK Query tag whenever a SUBSCRIPTION-typed notification arrives.
    createNotification({
        adminId: sub.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Payment approved",
        message: `Your payment has been confirmed. Your subscription is active through ${nextPeriodEnd.toLocaleDateString(
            "en-GB",
            { day: "numeric", month: "short", year: "numeric" },
        )}.`,
        relatedId: updatedSub.id,
    }).catch(() => {});

    return { billingRecord: updatedBilling, subscription: updatedSub };
};

/**
 * PATCH /super-admin/billing-history/:id/reject-proof
 * Super admin has reviewed the proof and found it invalid.
 *
 * Actions:
 *   1. BillingHistory status → FAILED
 *   2. Subscription status stays as-is (remains PENDING_PAYMENT so the
 *      tenant can re-submit or the admin can handle it manually).
 *   Optional body: { reason: string } — stored in the billing record note.
 */
const rejectPaymentProof = async (
    billingId: string,
    payload: { reason?: string },
) => {
    const { reason } = payload;

    const record = await prisma.billingHistory.findUnique({
        where: { id: billingId },
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
    });
    if (!record) {
        throw new AppError(status.NOT_FOUND, "Billing record not found.");
    }
    if (record.status !== "PENDING") {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot reject a proof with status "${record.status}". Only PENDING proofs can be rejected.`,
        );
    }
    if (!record.paymentProofUrl) {
        throw new AppError(
            status.BAD_REQUEST,
            "This billing record has no attached payment proof.",
        );
    }

    const updatedBilling = await prisma.billingHistory.update({
        where: { id: billingId },
        data: {
            status: "FAILED",
            note: reason
                ? `Rejected: ${reason}`
                : (record.note ?? "Rejected by super admin"),
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
    });

    // Notify the tenant admin in real time so they can see the rejection
    // reason and re-submit proof without needing to refresh/re-login.
    createNotification({
        adminId: record.subscription.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Payment proof rejected",
        message: reason
            ? `Your payment proof was rejected: ${reason}`
            : "Your payment proof was rejected. Please re-submit a valid proof of payment.",
        relatedId: record.id,
    }).catch(() => {});

    return updatedBilling;
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
    createAdminAccount,
    // Subscription plan CRUD
    createSubscriptionPlan,
    updateSubscriptionPlan,
    updatePricingTier,
    deleteSubscriptionPlan,
    toggleSubscriptionPlanStatus,
    // Subscription management
    getAllSubscriptions,
    cancelSubscription,
    getBillingHistory,
    extendTrial,
    reactivateSubscription,
    suspendSubscription,
    grantManualPayment,
    // Billing history actions
    refundBillingRecord,
    getBillingInvoice,
    // Payment proof review (manual payment loop)
    getPendingProofs,
    approvePaymentProof,
    rejectPaymentProof,
    // Platform config
    getPlatformConfig,
    updatePlatformConfig,
    // Trial nudge
    sendTrialNudge,
};
