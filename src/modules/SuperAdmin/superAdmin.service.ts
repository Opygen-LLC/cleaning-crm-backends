import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
    AccountStatus,
    PendingPlanChangeStatus,
    SubscriptionPlanInterval,
    SubscriptionStatus,
    UserRole,
} from "../../generated/prisma/enums";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { IPaginationOptions } from "../../interface/query.interface";
import {
    IActivityLogFilters,
    IAdminAccountFilters,
    ISubscriptionFilters,
} from "./superAdmin.interface";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { waitUntil } from "@vercel/functions";
import { auth } from "../../lib/auth";
import { adminService } from "../Admin/admin.service";
import { WebsiteProvisioningService } from "../Website/websiteProvisioning.service";
import { WebsiteHostResolverService } from "../Website/websiteHostResolver.service";
import { createNotification } from "../../lib/utils/createNotification";
import { emitToSuperAdmins } from "../../config/socketio";
import { NotificationType } from "../../generated/prisma/enums";
import {
    getPlatformConfig as sharedGetPlatformConfig,
    updatePlatformConfig as sharedUpdatePlatformConfig,
} from "../../lib/utils/platformConfig";
import { findNearMissFeatureLabels } from "../../lib/constants/featureGateLabels";
import {
    normalizeSubscriptionPlanFeatures,
    type SubscriptionPlanFeature,
} from "../../lib/utils/subscriptionPlanFeatures";
import type {
    TCreateSubscriptionPlanPayload,
    TUpdateSubscriptionPlanPayload,
} from "./superAdmin.validation";
import { invalidateSubscriptionAccessCache } from "../../middlewares/checkSubscription";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { invalidateRuntimeAuth, invalidateRuntimeTenantOwnerStatus } from "../../lib/cache/authRuntimeCache";
import { revokeAllSessionsForUser } from "../Auth/sessionSecurity.service";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPagination(options: IPaginationOptions) {
    const page = Number(options.page) || 1;
    const limit = Number(options.limit) || 10;
    const skip = (page - 1) * limit;
    return { page, limit, skip };
}

const invalidateAdminWebsiteRouting = async (adminProfileId: string | null | undefined) => {
    if (!adminProfileId) return;
    try {
        const website = await prisma.businessWebsite.findUnique({
            where: { adminId: adminProfileId },
            select: {
                subdomain: true,
                subdomainAliases: { select: { subdomain: true } },
                domains: { select: { domain: true } },
            },
        });
        if (!website) return;

        await Promise.all([
            WebsiteHostResolverService.invalidateSubdomains([
                website.subdomain,
                ...website.subdomainAliases.map((alias) => alias.subdomain),
            ]),
            WebsiteHostResolverService.invalidateHosts(website.domains.map((domain) => domain.domain)),
        ]);
    } catch {
        // Account suspension/activation is authoritative in Postgres. Routing
        // cache cleanup is best-effort; the public projection still re-checks
        // account status and the short routing TTL self-heals if this lookup fails.
    }
};

const invalidateAdminSubscriptionState = async (adminProfileId: string) => {
    const owner = await prisma.adminProfile.findUnique({
        where: { id: adminProfileId },
        select: { userId: true },
    });
    if (owner?.userId) await invalidateSubscriptionAccessCache(owner.userId);
};

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
                        plan: { select: { interval: true } },
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
        select: { id: true, admin: { select: { id: true } } },
    });

    if (!admin) {
        throw new AppError(status.NOT_FOUND, "Admin account not found.");
    }

    const updated = await prisma.user.update({
        where: { id: adminId },
        data: { status: AccountStatus.SUSPENDED },
        select: { id: true, name: true, email: true, status: true },
    });
    await revokeAllSessionsForUser(adminId);
    invalidateRuntimeAuth(adminId);
    invalidateRuntimeTenantOwnerStatus(admin.admin?.id);
    await invalidateSubscriptionAccessCache(adminId);
    await Promise.all([
        WebsiteProjectionCacheService.invalidateAdminWebsite(admin.admin?.id),
        invalidateAdminWebsiteRouting(admin.admin?.id),
    ]);
    return updated;
};

const activateAdminAccount = async (adminId: string) => {
    const admin = await prisma.user.findFirst({
        where: { id: adminId, role: UserRole.ADMIN },
        select: { id: true, admin: { select: { id: true } } },
    });

    if (!admin) {
        throw new AppError(status.NOT_FOUND, "Admin account not found.");
    }

    const updated = await prisma.user.update({
        where: { id: adminId },
        data: { status: AccountStatus.ACTIVE },
        select: { id: true, name: true, email: true, status: true },
    });
    invalidateRuntimeAuth(adminId);
    invalidateRuntimeTenantOwnerStatus(admin.admin?.id);
    await invalidateSubscriptionAccessCache(adminId);
    await Promise.all([
        WebsiteProjectionCacheService.invalidateAdminWebsite(admin.admin?.id),
        invalidateAdminWebsiteRouting(admin.admin?.id),
    ]);
    return updated;
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
        const { user, admin, website } = await prisma.$transaction(async (tx) => {
            const user = await tx.user.update({
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

            const admin = await adminService.createAdmin(
                {
                    userId: data.user.id,
                    businessName,
                },
                tx,
            );

            const { website } =
                await WebsiteProvisioningService.provisionDefaultWebsiteForAdminTx(
                    tx,
                    {
                        adminId: admin.id,
                        businessName,
                        createdByUserId: data.user.id,
                    },
                );

            return { user, admin, website };
        });

        // A free subdomain can be negatively cached if someone probed it
        // before this admin was created. Invalidate only after the tenant
        // transaction commits so the new hostname becomes live immediately.
        await WebsiteHostResolverService.invalidateSubdomains([website.subdomain]);

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
            website,
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

// ─── Subscription Plan management ─────────────────────────────────────────────

const TIER_ORDER: Record<string, number> = {
    STARTER: 0,
    GROWTH: 1,
    PRO: 2,
    CUSTOM: 3,
};

function planFeatureJson(features: SubscriptionPlanFeature[]) {
    return features as unknown as Prisma.InputJsonValue;
}

const getSuperAdminSubscriptionPlans = async () => {
    const [rows, activeCounts, mrrRows] = await Promise.all([
        prisma.subscriptionPlan.findMany({
            include: {
                plans: true,
                _count: { select: { subscriptions: true } },
            },
        }),
        prisma.subscription.groupBy({
            by: ["subscriptionPlanId", "isTrial"],
            where: { status: SubscriptionStatus.ACTIVE },
            _count: { _all: true },
        }),
        prisma.$queryRaw<{ subscriptionPlanId: string; mrr: unknown }[]>(
            Prisma.sql`
                SELECT
                    s."subscriptionPlanId" AS "subscriptionPlanId",
                    COALESCE(
                        SUM(
                            CASE
                                WHEN p."interval"::text = 'YEARLY' THEN s."totalCost" / 12
                                ELSE s."totalCost"
                            END
                        ),
                        0
                    ) AS "mrr"
                FROM "Subscription" s
                INNER JOIN "Plan" p ON p."id" = s."planId"
                WHERE s."status"::text = 'ACTIVE' AND s."isTrial" = false
                GROUP BY s."subscriptionPlanId"
            `,
        ),
    ]);

    const countsByPlan = new Map<
        string,
        { activeSubscribers: number; paidSubscribers: number; trialSubscribers: number }
    >();
    for (const row of activeCounts) {
        const current = countsByPlan.get(row.subscriptionPlanId) ?? {
            activeSubscribers: 0,
            paidSubscribers: 0,
            trialSubscribers: 0,
        };
        const count = row._count._all;
        current.activeSubscribers += count;
        if (row.isTrial) current.trialSubscribers += count;
        else current.paidSubscribers += count;
        countsByPlan.set(row.subscriptionPlanId, current);
    }

    const mrrByPlan = new Map(
        mrrRows.map((row) => [row.subscriptionPlanId, Number(row.mrr ?? 0)]),
    );

    const plans = rows
        .map((row) => {
            const counts = countsByPlan.get(row.id) ?? {
                activeSubscribers: 0,
                paidSubscribers: 0,
                trialSubscribers: 0,
            };
            const { _count, ...plan } = row;
            return {
                ...plan,
                features: normalizeSubscriptionPlanFeatures(plan.features),
                ...counts,
                subscriberCount: _count.subscriptions,
                mrr: Number((mrrByPlan.get(row.id) ?? 0).toFixed(2)),
            };
        })
        .sort(
            (a, b) =>
                (TIER_ORDER[a.name] ?? Number.MAX_SAFE_INTEGER) -
                (TIER_ORDER[b.name] ?? Number.MAX_SAFE_INTEGER),
        );

    const currencies = new Set(plans.map((plan) => plan.currency));
    const hasSingleCurrency = currencies.size === 1;
    const totalMrr = hasSingleCurrency
        ? Number(plans.reduce((sum, plan) => sum + plan.mrr, 0).toFixed(2))
        : 0;

    return {
        plans,
        stats: {
            totalPlans: plans.length,
            activePlans: plans.filter((plan) => plan.isActive).length,
            totalSubscribers: plans.reduce(
                (sum, plan) => sum + plan.activeSubscribers,
                0,
            ),
            paidSubscribers: plans.reduce(
                (sum, plan) => sum + plan.paidSubscribers,
                0,
            ),
            trialSubscribers: plans.reduce(
                (sum, plan) => sum + plan.trialSubscribers,
                0,
            ),
            totalMrr,
            currency: hasSingleCurrency ? [...currencies][0] : null,
        },
    };
};

const getSuperAdminSubscriptionPlanById = async (id: string) => {
    const result = await getSuperAdminSubscriptionPlans();
    const plan = result.plans.find((item) => item.id === id);
    if (!plan) {
        throw new AppError(status.NOT_FOUND, "Subscription plan not found.");
    }
    return plan;
};

function assertFeatureLabels(features: SubscriptionPlanFeature[]) {
    const nearMisses = findNearMissFeatureLabels(
        features.map((feature) => feature.label),
    );
    if (nearMisses.length > 0) {
        throw new AppError(
            status.BAD_REQUEST,
            `Feature label(s) look like typos of a known gate string: ${nearMisses
                .map(
                    (warning) =>
                        `"${warning.submitted}" (did you mean "${warning.closestCanonical}"?)`,
                )
                .join("; ")}. Use the exact canonical label, or pick it from the plan editor's checklist.`,
        );
    }
}

const createSubscriptionPlan = async (payload: TCreateSubscriptionPlanPayload) => {
    const features = normalizeSubscriptionPlanFeatures(payload.features);
    assertFeatureLabels(features);

    const existing = await prisma.subscriptionPlan.findUnique({
        where: { name: payload.name },
        select: { id: true },
    });
    if (existing) {
        throw new AppError(
            status.CONFLICT,
            `${payload.name} already exists. The platform uses four fixed plan tiers; edit or reactivate the existing tier instead.`,
        );
    }

    const created = await prisma.$transaction(async (tx) => {
        const subscriptionPlan = await tx.subscriptionPlan.create({
            data: {
                name: payload.name as import("../../generated/prisma/enums").SubscriptionName,
                description: payload.description,
                currency: payload.currency as import("../../generated/prisma/enums").Currency,
                features: planFeatureJson(features),
            },
        });

        await Promise.all(
            payload.plans.map((tier) =>
                tx.plan.create({
                    data: {
                        subscriptionPlanId: subscriptionPlan.id,
                        interval: tier.interval as SubscriptionPlanInterval,
                        price: tier.price,
                        baseCharge: tier.baseCharge ?? 0,
                        pricePerStaff: tier.pricePerStaff ?? 0,
                        pricePerClient: tier.pricePerClient ?? 0,
                        pricePerBooking: tier.pricePerBooking ?? 0,
                        maxStaff: tier.maxStaff,
                        maxClient: tier.maxClient,
                        maxBookingsPerMonth: tier.maxBookingsPerMonth,
                        discount: tier.discount ?? 0,
                        discountEndDate: tier.discountEndDate
                            ? new Date(tier.discountEndDate)
                            : null,
                    },
                }),
            ),
        );

        return tx.subscriptionPlan.findUniqueOrThrow({
            where: { id: subscriptionPlan.id },
            include: { plans: true },
        });
    });

    return {
        ...created,
        features: normalizeSubscriptionPlanFeatures(created.features),
        activeSubscribers: 0,
        paidSubscribers: 0,
        trialSubscribers: 0,
        subscriberCount: 0,
        mrr: 0,
    };
};

const updateSubscriptionPlan = async (
    id: string,
    payload: TUpdateSubscriptionPlanPayload,
) => {
    const current = await prisma.subscriptionPlan.findUnique({
        where: { id },
        include: { plans: true },
    });
    if (!current) {
        throw new AppError(status.NOT_FOUND, "Subscription plan not found.");
    }

    const nextFeatures =
        payload.features === undefined
            ? normalizeSubscriptionPlanFeatures(current.features)
            : normalizeSubscriptionPlanFeatures(payload.features);
    if (payload.features !== undefined) assertFeatureLabels(nextFeatures);

    const previousFeatures = normalizeSubscriptionPlanFeatures(current.features);
    const featuresChanged =
        payload.features !== undefined &&
        JSON.stringify(previousFeatures) !== JSON.stringify(nextFeatures);

    await prisma.$transaction(async (tx) => {
        await tx.subscriptionPlan.update({
            where: { id },
            data: {
                description: payload.description,
                currency: payload.currency as
                    | import("../../generated/prisma/enums").Currency
                    | undefined,
                isActive: payload.isActive,
                features:
                    payload.features === undefined
                        ? undefined
                        : planFeatureJson(nextFeatures),
            },
        });

        for (const tier of payload.plans ?? []) {
            const interval = tier.interval as SubscriptionPlanInterval;
            const tierWhere = {
                subscriptionPlanId_interval: {
                    subscriptionPlanId: id,
                    interval,
                },
            };
            const existingTier = await tx.plan.findUnique({
                where: tierWhere,
                select: { id: true },
            });

            const tierData = {
                price: tier.price,
                baseCharge: tier.baseCharge,
                pricePerStaff: tier.pricePerStaff,
                pricePerClient: tier.pricePerClient,
                pricePerBooking: tier.pricePerBooking,
                maxStaff: tier.maxStaff,
                maxClient: tier.maxClient,
                maxBookingsPerMonth: tier.maxBookingsPerMonth,
                discount: tier.discount,
                discountEndDate:
                    tier.discountEndDate === undefined
                        ? undefined
                        : tier.discountEndDate
                          ? new Date(tier.discountEndDate)
                          : null,
            };

            if (existingTier) {
                await tx.plan.update({ where: { id: existingTier.id }, data: tierData });
                continue;
            }

            if (tier.price === undefined) {
                throw new AppError(
                    status.BAD_REQUEST,
                    `${tier.interval.toLowerCase()} pricing is missing a price and cannot be created.`,
                );
            }

            await tx.plan.create({
                data: {
                    subscriptionPlanId: id,
                    interval,
                    price: tier.price,
                    baseCharge: tier.baseCharge ?? 0,
                    pricePerStaff: tier.pricePerStaff ?? 0,
                    pricePerClient: tier.pricePerClient ?? 0,
                    pricePerBooking: tier.pricePerBooking ?? 0,
                    maxStaff: tier.maxStaff,
                    maxClient: tier.maxClient,
                    maxBookingsPerMonth: tier.maxBookingsPerMonth,
                    discount: tier.discount ?? 0,
                    discountEndDate: tier.discountEndDate
                        ? new Date(tier.discountEndDate)
                        : null,
                },
            });
        }
    });

    if (featuresChanged) {
        const affectedSubscriptions = await prisma.subscription.findMany({
            where: { subscriptionPlanId: id, status: SubscriptionStatus.ACTIVE },
            select: {
                id: true,
                adminId: true,
                admin: { select: { userId: true } },
            },
        });

        await Promise.allSettled(
            affectedSubscriptions.flatMap((subscription) => [
                invalidateSubscriptionAccessCache(subscription.admin.userId),
                createNotification({
                    adminId: subscription.adminId,
                    type: NotificationType.SUBSCRIPTION,
                    title: "Your plan's features were updated",
                    message:
                        "The features included in your subscription plan have changed. Your access has been refreshed automatically.",
                    relatedId: subscription.id,
                }),
            ]),
        );
    }

    return getSuperAdminSubscriptionPlanById(id);
};

// Compatibility endpoint for older clients. The new editor sends pricing and
// metadata in one PATCH /subscription-plans/:id transaction.
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
        maxStaff?: number | null;
        maxClient?: number | null;
        maxBookingsPerMonth?: number | null;
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
            discountEndDate:
                payload.discountEndDate === undefined
                    ? undefined
                    : payload.discountEndDate
                      ? new Date(payload.discountEndDate)
                      : null,
        },
    });
};

const deleteSubscriptionPlan = async (_id: string) => {
    throw new AppError(
        status.BAD_REQUEST,
        "The platform uses fixed STARTER, GROWTH, PRO and CUSTOM tiers. Deactivate a tier instead of deleting it.",
    );
};

const toggleSubscriptionPlanStatus = async (id: string, isActive: boolean) =>
    updateSubscriptionPlan(id, { isActive });

// ─── Admin Subscription Management (super admin actions) ─────────────────────

const getAllSubscriptions = async (
    filters: ISubscriptionFilters,
    paginationOptions: IPaginationOptions,
) => {
    const { page, limit, skip } = buildPagination(paginationOptions);

    const where: Prisma.SubscriptionWhereInput = {};
    if (filters.status) where.status = filters.status as SubscriptionStatus;
    if (filters.planId) where.planId = filters.planId;
    if (filters.isTrial !== undefined)
        where.isTrial = filters.isTrial === "true";
    if (filters.plan)
        where.subscriptionPlan = {
            name: filters.plan as import("../../generated/prisma/enums").SubscriptionName,
        };
    if (filters.billingCycle)
        where.plan = {
            interval: filters.billingCycle === "annual" ? "YEARLY" : "MONTHLY",
        };
    if (filters.search) {
        where.admin = {
            OR: [
                {
                    businessName: {
                        contains: filters.search,
                        mode: "insensitive",
                    },
                },
                {
                    user: {
                        is: {
                            name: {
                                contains: filters.search,
                                mode: "insensitive",
                            },
                        },
                    },
                },
                {
                    user: {
                        is: {
                            email: {
                                contains: filters.search,
                                mode: "insensitive",
                            },
                        },
                    },
                },
            ],
        };
    }

    // Map the FE's virtual sort keys onto the actual (possibly relational)
    // Prisma fields they're derived from. Defaults to newest-first.
    const sortDir = filters.sortDir ?? "desc";
    let orderBy: Prisma.SubscriptionOrderByWithRelationInput = {
        createdAt: "desc",
    };
    switch (filters.sortField) {
        case "adminName":
            orderBy = { admin: { businessName: sortDir } };
            break;
        case "plan":
            orderBy = { subscriptionPlan: { name: sortDir } };
            break;
        case "status":
            orderBy = { status: sortDir };
            break;
        case "mrr":
            orderBy = { plan: { price: sortDir } };
            break;
        case "billingCycle":
            orderBy = { plan: { interval: sortDir } };
            break;
        case "nextBillingDate":
            orderBy = { currentPeriodEnd: sortDir };
            break;
        case "startedAt":
            orderBy = { createdAt: sortDir };
            break;
        default:
            orderBy = { createdAt: "desc" };
    }

    const [
        total,
        data,
        activeNonTrialCount,
        activeTrialCount,
        suspendedCount,
        annualActiveCount,
        mrrSubs,
    ] = await Promise.all([
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
            orderBy,
            skip,
            take: limit,
        }),
        // ── Stats row — BUGFIX: previously derived client-side from only the
        // current page of (at most `limit`) rows, so "Total MRR" / counts
        // changed depending on which page or filter was active. These five
        // aggregates are global (unaffected by the table's own filters/
        // pagination), matching how getPlatformStats computes the same
        // active/trial split elsewhere in this file.
        prisma.subscription.count({
            where: { status: SubscriptionStatus.ACTIVE, isTrial: false },
        }),
        prisma.subscription.count({
            where: { status: SubscriptionStatus.ACTIVE, isTrial: true },
        }),
        prisma.subscription.count({
            where: { status: SubscriptionStatus.SUSPENDED },
        }),
        prisma.subscription.count({
            where: {
                status: SubscriptionStatus.ACTIVE,
                isTrial: false,
                plan: { interval: "YEARLY" },
            },
        }),
        prisma.subscription.findMany({
            where: { status: SubscriptionStatus.ACTIVE, isTrial: false },
            select: { plan: { select: { price: true } } },
        }),
    ]);

    const totalMRR = mrrSubs.reduce(
        (sum, s) => sum + Number(s.plan?.price ?? 0),
        0,
    );

    return {
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        data,
        stats: {
            totalMRR: parseFloat(totalMRR.toFixed(2)),
            activeCount: activeNonTrialCount,
            trialCount: activeTrialCount,
            suspendedCount,
            annualCount: annualActiveCount,
        },
    };
};

const cancelSubscription = async (subscriptionId: string) => {
    const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
    });
    if (!sub) {
        throw new AppError(status.NOT_FOUND, "Subscription not found.");
    }

    const updated = await prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
            status: SubscriptionStatus.CANCELLED,
            canceledAt: new Date(),
        },
        include: { plan: true, subscriptionPlan: true },
    });

    // BUGFIX: this was DB-only. checkSubscription.ts's own comment notes the
    // frontend's useGateMap already treats "Cancelled" as hasActiveAccess ===
    // false — but without a live push the sidebar kept showing everything
    // unlocked (stale cache) until the admin's next 402 or a re-login.
    createNotification({
        adminId: sub.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Subscription cancelled",
        message:
            "Your subscription has been cancelled by the platform admin. Subscribe to a plan to restore access.",
        relatedId: updated.id,
    }).catch(() => {});

    await invalidateAdminSubscriptionState(sub.adminId);
    return updated;
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
                        plan: { select: { interval: true } },
                        admin: {
                            select: {
                                businessName: true,
                                user: { select: { name: true, email: true } },
                            },
                        },
                    },
                },
                pendingPlanChange: {
                    include: {
                        targetPlan: {
                            include: {
                                subscriptionPlan: { select: { name: true } },
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

    // BUGFIX: DB-only before. This is the super-admin-initiated equivalent of
    // approvePaymentProof (payment recorded off-platform, no proof upload) and
    // needs the same live push so the tenant's lockout wall clears and their
    // sidebar unlocks without a re-login.
    createNotification({
        adminId: sub.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Payment recorded",
        message: `A payment has been recorded on your account. Your subscription is active through ${nextPeriodEnd.toLocaleDateString(
            "en-GB",
            { day: "numeric", month: "short", year: "numeric" },
        )}.`,
        relatedId: updatedSub.id,
    }).catch(() => {});

    await invalidateAdminSubscriptionState(sub.adminId);
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

    const updated = await prisma.subscription.update({
        where: { id: subscriptionId },
        data: { status: SubscriptionStatus.SUSPENDED },
        include: { plan: true, subscriptionPlan: true },
    });

    // BUGFIX: DB-only before — the admin kept full access in their open tab
    // until they hit a 402 on some other request. checkSubscription.ts blocks
    // SUSPENDED at the API layer immediately, but the sidebar/feature-gate UI
    // didn't know until a manual refresh or re-login.
    createNotification({
        adminId: sub.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Account suspended",
        message:
            "Your account has been suspended by the platform admin. Please contact support or submit a payment proof.",
        relatedId: updated.id,
    }).catch(() => {});

    await invalidateAdminSubscriptionState(sub.adminId);
    return updated;
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

    const updated = await prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
            status: SubscriptionStatus.ACTIVE,
            cancelAtPeriodEnd: false,
            canceledAt: null,
        },
        include: { plan: true, subscriptionPlan: true },
    });

    // BUGFIX: DB-only before — reactivation is the moment the admin's lockout
    // wall should disappear and their sidebar unlock; without this push that
    // only happened after their next request 402'd through to a fresh fetch,
    // or after a re-login.
    createNotification({
        adminId: sub.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Account reactivated",
        message: "Your account has been reactivated. Access has been restored.",
        relatedId: updated.id,
    }).catch(() => {});

    await invalidateAdminSubscriptionState(sub.adminId);
    return updated;
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

    const updated = await prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
            trialEndsAt: newTrialEnd,
            currentPeriodEnd: newPeriodEnd,
            // Restore ACTIVE if the trial had expired
            status: SubscriptionStatus.ACTIVE,
        },
        include: { plan: true, subscriptionPlan: true },
    });

    // BUGFIX: DB-only before. When extendTrial is used to rescue an EXPIRED
    // trial (the common case — a super admin granting grace time after the
    // subscriptionExpiry cron locked the account), the admin's lockout wall
    // needs to clear immediately, not just after their next request 402s
    // through to a fresh fetch or they log back in.
    createNotification({
        adminId: sub.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Trial extended",
        message: `Your free trial has been extended through ${newTrialEnd.toLocaleDateString(
            "en-GB",
            { day: "numeric", month: "short", year: "numeric" },
        )}.`,
        relatedId: updated.id,
    }).catch(() => {});

    await invalidateAdminSubscriptionState(sub.adminId);
    return updated;
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
            upgradeUrl: `${process.env.FRONTEND_URL ?? "https://app.opygen.io"}/admin/dashboard/settings/subscription`,
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
                        plan: { select: { interval: true } },
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

    if (shouldSuspend) {
        await invalidateAdminSubscriptionState(sub.adminId);
    }

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
            // PERF FIX (Phase 2, performance audit): this 3-level-deep include
            // (subscription -> subscriptionPlan, subscription -> admin -> user)
            // was previously loaded via Prisma's default "query" strategy —
            // multiple separate round trips to Postgres, joined in application
            // code. That's the exact source of the
            // `AdminProfile ... WHERE id IN (NULL)` wasted round trip seen in
            // production logs (a relation batch-fetch that ran even though it
            // had nothing to fetch). `relationLoadStrategy: "join"` (enabled via
            // the `relationJoins` preview feature in schema.prisma) fetches all
            // of this in a single DB-level LATERAL JOIN query instead — that
            // wasted round trip disappears entirely, and this endpoint drops
            // from 4+ sequential round trips down to 2 (count + this query, run
            // in parallel above).
            relationLoadStrategy: "join",
            include: {
                subscription: {
                    include: {
                        subscriptionPlan: { select: { name: true } },
                        plan: { select: { interval: true } },
                        admin: {
                            select: {
                                businessName: true,
                                user: { select: { name: true, email: true } },
                            },
                        },
                    },
                },
                pendingPlanChange: {
                    include: {
                        targetPlan: {
                            include: {
                                subscriptionPlan: { select: { name: true } },
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
 * Approves either a Phase-6 pending plan checkout or a legacy manual proof.
 * For a plan checkout, billing + plan activation + coupon redemption are one
 * atomic transaction; the existing subscription is never changed beforehand.
 */
const approvePaymentProof = async (
    billingId: string,
    payload: { periodMonths?: number; note?: string },
) => {
    const { periodMonths = 1, note } = payload;

    const record = await prisma.billingHistory.findUnique({
        where: { id: billingId },
        include: {
            subscription: {
                include: {
                    admin: { select: { userId: true } },
                },
            },
            pendingPlanChange: {
                include: {
                    targetPlan: { include: { subscriptionPlan: true } },
                    coupon: true,
                },
            },
        },
    });
    if (!record) throw new AppError(status.NOT_FOUND, "Billing record not found.");
    if (record.status !== "PENDING") {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot approve a proof with status "${record.status}". Only PENDING proofs can be approved.`,
            { code: "PAYMENT_PROOF_NOT_PENDING", retryable: false },
        );
    }
    if (!record.paymentProofUrl) {
        throw new AppError(status.BAD_REQUEST, "This billing record has no attached payment proof.");
    }

    const sub = record.subscription;
    const checkout = record.pendingPlanChange;

    if (checkout) {
        if (
            checkout.status !== PendingPlanChangeStatus.UNDER_REVIEW
        ) {
            throw new AppError(
                status.CONFLICT,
                "This plan checkout is no longer awaiting approval.",
                { code: "PLAN_CHANGE_NOT_UNDER_REVIEW", retryable: false },
            );
        }

        const now = new Date();
        const nextPeriodEnd = new Date(now);
        if (checkout.targetPlan.interval === SubscriptionPlanInterval.YEARLY) {
            nextPeriodEnd.setFullYear(nextPeriodEnd.getFullYear() + 1);
        } else {
            nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);
        }

        const lockKey = `subscription-checkout:${sub.id}`;
        const result = await prisma.$transaction(async (tx) => {
            await acquireExtendedTextTransactionAdvisoryLock(tx, lockKey);
            if (checkout.couponId) {
                const couponLockKey = `subscription-coupon:${checkout.couponId}`;
                await acquireExtendedTextTransactionAdvisoryLock(tx, couponLockKey);
            }

            const freshBilling = await tx.billingHistory.findUnique({
                where: { id: billingId },
            });
            const freshCheckout = await tx.pendingPlanChange.findUnique({
                where: { id: checkout.id },
            });
            if (!freshBilling || freshBilling.status !== "PENDING") {
                throw new AppError(status.CONFLICT, "This payment proof has already been reviewed.", {
                    code: "PAYMENT_PROOF_ALREADY_REVIEWED",
                    retryable: false,
                });
            }
            if (
                !freshCheckout ||
                freshCheckout.status !== PendingPlanChangeStatus.UNDER_REVIEW
            ) {
                throw new AppError(status.CONFLICT, "This plan checkout has already been resolved.", {
                    code: "PLAN_CHANGE_ALREADY_RESOLVED",
                    retryable: false,
                });
            }

            if (freshCheckout.couponId) {
                const priorUsage = await tx.couponUsage.findUnique({
                    where: {
                        couponId_adminId: {
                            couponId: freshCheckout.couponId,
                            adminId: sub.adminId,
                        },
                    },
                });
                if (priorUsage) {
                    throw new AppError(status.CONFLICT, "This coupon has already been used by this account.", {
                        code: "COUPON_ALREADY_USED",
                        retryable: false,
                    });
                }
            }

            const updatedBilling = await tx.billingHistory.update({
                where: { id: billingId },
                data: {
                    status: "PAID",
                    paidAt: now,
                    note: note ?? freshBilling.note,
                },
            });

            const updatedSub = await tx.subscription.update({
                where: { id: sub.id },
                data: {
                    planId: checkout.targetPlanId,
                    subscriptionPlanId: checkout.targetPlan.subscriptionPlanId,
                    couponId: checkout.couponId,
                    totalCost: checkout.quotedAmount,
                    status: SubscriptionStatus.ACTIVE,
                    isTrial: false,
                    trialEndsAt: null,
                    currentPeriodStart: now,
                    currentPeriodEnd: nextPeriodEnd,
                    cancelAtPeriodEnd: false,
                    canceledAt: null,
                },
                include: { plan: true, subscriptionPlan: true, coupon: true },
            });

            await tx.pendingPlanChange.update({
                where: { id: checkout.id },
                data: {
                    status: PendingPlanChangeStatus.APPROVED,
                    reviewedAt: now,
                    rejectionReason: null,
                },
            });

            if (checkout.couponId) {
                await tx.couponUsage.create({
                    data: {
                        couponId: checkout.couponId,
                        adminId: sub.adminId,
                        subscriptionId: sub.id,
                    },
                });
                await tx.coupon.update({
                    where: { id: checkout.couponId },
                    data: { usedCount: { increment: 1 } },
                });
            }

            return { updatedBilling, updatedSub };
        });

        await invalidateSubscriptionAccessCache(sub.admin.userId);

        createNotification({
            adminId: sub.adminId,
            type: NotificationType.SUBSCRIPTION,
            title: "Plan activated",
            message: `Your ${checkout.targetPlan.subscriptionPlan.name} plan is now active through ${nextPeriodEnd.toLocaleDateString(
                "en-GB",
                { day: "numeric", month: "short", year: "numeric" },
            )}.`,
            relatedId: result.updatedSub.id,
        }).catch(() => {});

        emitToSuperAdmins("payment-proof:approved", {
            billingId: result.updatedBilling.id,
            planChangeId: checkout.id,
            adminId: sub.adminId,
        });

        return {
            billingRecord: result.updatedBilling,
            subscription: result.updatedSub,
            pendingPlanChange: { id: checkout.id, status: PendingPlanChangeStatus.APPROVED },
        };
    }

    // Legacy proof path for PENDING_PAYMENT subscriptions created before Phase 6.
    const baseDate =
        sub.currentPeriodEnd && sub.currentPeriodEnd > new Date()
            ? new Date(sub.currentPeriodEnd)
            : new Date();
    const nextPeriodEnd = new Date(baseDate);
    nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + periodMonths);

    const [updatedBilling, updatedSub] = await prisma.$transaction([
        prisma.billingHistory.update({
            where: { id: billingId },
            data: { status: "PAID", paidAt: new Date(), note: note ?? record.note },
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

    await invalidateSubscriptionAccessCache(sub.admin.userId);
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
    emitToSuperAdmins("payment-proof:approved", {
        billingId: updatedBilling.id,
        adminId: sub.adminId,
    });
    return { billingRecord: updatedBilling, subscription: updatedSub };
};

/**
 * Rejecting a Phase-6 checkout never modifies the tenant's live subscription.
 * The rejected checkout remains available for re-submission so the tenant can
 * correct the proof without rebuilding the cart.
 */
const rejectPaymentProof = async (
    billingId: string,
    payload: { reason?: string },
) => {
    const reason = payload.reason?.trim();
    const record = await prisma.billingHistory.findUnique({
        where: { id: billingId },
        include: {
            subscription: true,
            pendingPlanChange: true,
        },
    });
    if (!record) throw new AppError(status.NOT_FOUND, "Billing record not found.");
    if (record.status !== "PENDING") {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot reject a proof with status "${record.status}". Only PENDING proofs can be rejected.`,
            { code: "PAYMENT_PROOF_NOT_PENDING", retryable: false },
        );
    }
    if (!record.paymentProofUrl) {
        throw new AppError(status.BAD_REQUEST, "This billing record has no attached payment proof.");
    }

    const now = new Date();
    const checkoutRetryUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const lockKey = `subscription-checkout:${record.subscriptionId}`;
    const updatedBilling = await prisma.$transaction(async (tx) => {
        await acquireExtendedTextTransactionAdvisoryLock(tx, lockKey);
        const freshBilling = await tx.billingHistory.findUnique({ where: { id: billingId } });
        if (!freshBilling || freshBilling.status !== "PENDING") {
            throw new AppError(status.CONFLICT, "This payment proof has already been reviewed.", {
                code: "PAYMENT_PROOF_ALREADY_REVIEWED",
                retryable: false,
            });
        }

        const updated = await tx.billingHistory.update({
            where: { id: billingId },
            data: {
                status: "FAILED",
                note: reason ? `Rejected: ${reason}` : (record.note ?? "Rejected by super admin"),
            },
        });

        if (record.pendingPlanChange) {
            await tx.pendingPlanChange.update({
                where: { id: record.pendingPlanChange.id },
                data: {
                    status: PendingPlanChangeStatus.REJECTED,
                    reviewedAt: now,
                    rejectionReason: reason ?? "Payment proof could not be verified.",
                    expiresAt: checkoutRetryUntil,
                },
            });
        }
        return updated;
    });

    createNotification({
        adminId: record.subscription.adminId,
        type: NotificationType.SUBSCRIPTION,
        title: "Payment proof rejected",
        message: reason
            ? `Your payment proof was rejected: ${reason}`
            : "Your payment proof was rejected. Please upload a clearer or corrected proof.",
        relatedId: record.pendingPlanChange?.id ?? record.id,
    }).catch(() => {});

    emitToSuperAdmins("payment-proof:rejected", {
        billingId: updatedBilling.id,
        planChangeId: record.pendingPlanChange?.id ?? null,
        adminId: record.subscription.adminId,
    });

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
    getSuperAdminSubscriptionPlans,
    getSuperAdminSubscriptionPlanById,
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
