import { mediaService } from "../Media/media.service";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
    PendingPlanChangeStatus,
    Prisma,
    SubscriptionName,
    SubscriptionPlanInterval,
    SubscriptionStatus,
} from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { IRequestUser } from "../../types/requestUser.interface";
import { Decimal } from "@prisma/client/runtime/client";
import { getPlatformConfig } from "../../lib/utils/platformConfig";
import { emitToSuperAdmins } from "../../config/socketio";
import { invalidateSubscriptionAccessCache } from "../../middlewares/checkSubscription";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { TenantAccessResolver } from "../Entitlement/tenantAccessResolver.service";
import { startOfMonth } from "date-fns";

// Fallback only — the real value is read from platform config
// (super-admin → Settings → Platform Configuration → "Default trial days")
// at the moment each trial is created, so changing the setting takes effect
// for all new signups immediately without a redeploy.
const FALLBACK_TRIAL_DAYS = 7;
const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type SubscriptionLifecycleState =
    | "TRIAL_ACTIVE"
    | "TRIAL_EXPIRED"
    | "PAID_ACTIVE"
    | "PAID_EXPIRED"
    | "CANCEL_AT_PERIOD_END"
    | "CANCELLED"
    | "PAYMENT_PENDING"
    | "SUSPENDED"
    | "ACCESS_BLOCKED";

const percentage = (current: number, limit: number | null): number | null => {
    if (limit === null) return null;
    if (limit <= 0) return 100;
    return Math.min(100, Math.round((current / limit) * 100));
};

const getSubscriptionUsageSnapshot = async (
    adminId: string,
    limits: { staff: number | null; clients: number | null; monthlyBookings: number | null },
    now: Date,
) => {
    // Keep this endpoint usable after expiry. /admin/usage is intentionally
    // behind the subscription gate, but /subscription/me is a recovery route.
    const monthStart = startOfMonth(now);
    type UsageRow = {
        staffCount: number;
        clientCount: number;
        bookingCountThisMonth: number;
    };
    const [row] = await prisma.$queryRaw<UsageRow[]>`
      SELECT
        -- Match assertWithinLimit() exactly: inactive staff/client records still
        -- consume plan capacity until they are actually removed. This keeps
        -- the recovery UI from advertising capacity that gated create routes
        -- will reject.
        (SELECT COUNT(*)::int FROM "StaffProfile" sp
          WHERE sp."adminId" = ${adminId}) AS "staffCount",
        (SELECT COUNT(*)::int FROM "client" c
          WHERE c."adminId" = ${adminId}) AS "clientCount",
        (SELECT COUNT(*)::int FROM "booking" b
          WHERE b."adminId" = ${adminId} AND b."createdAt" >= ${monthStart}) AS "bookingCountThisMonth"
    `;
    const staffCount = row?.staffCount ?? 0;
    const clientCount = row?.clientCount ?? 0;
    const bookingCountThisMonth = row?.bookingCountThisMonth ?? 0;

    return {
        measuredAt: now.toISOString(),
        staffCount,
        clientCount,
        bookingCountThisMonth,
        limits: {
            staff: limits.staff,
            clients: limits.clients,
            bookingsPerMonth: limits.monthlyBookings,
        },
        percentages: {
            staff: percentage(staffCount, limits.staff),
            clients: percentage(clientCount, limits.clients),
            bookingsPerMonth: percentage(bookingCountThisMonth, limits.monthlyBookings),
        },
    };
};

const getLifecycleState = (
    subscription: {
        status: SubscriptionStatus;
        isTrial: boolean;
        cancelAtPeriodEnd: boolean;
    },
    deniedReason: string,
): SubscriptionLifecycleState => {
    if (subscription.status === SubscriptionStatus.SUSPENDED || deniedReason === "SUBSCRIPTION_SUSPENDED") {
        return "SUSPENDED";
    }
    if (subscription.status === SubscriptionStatus.PENDING_PAYMENT || deniedReason === "PAYMENT_PENDING") {
        return "PAYMENT_PENDING";
    }
    if (subscription.status === SubscriptionStatus.CANCELLED) return "CANCELLED";
    if (deniedReason === "TRIAL_EXPIRED") return "TRIAL_EXPIRED";
    if (subscription.isTrial && deniedReason === "SUBSCRIPTION_EXPIRED") return "TRIAL_EXPIRED";
    if (!subscription.isTrial && deniedReason === "SUBSCRIPTION_EXPIRED") return "PAID_EXPIRED";
    if (deniedReason !== "ACTIVE") return "ACCESS_BLOCKED";
    if (subscription.cancelAtPeriodEnd) return "CANCEL_AT_PERIOD_END";
    return subscription.isTrial ? "TRIAL_ACTIVE" : "PAID_ACTIVE";
};

// ─── Helper: resolve AdminProfile.id from the authenticated User ─────────────
// BUGFIX: Subscription.adminId is a foreign key to AdminProfile.id, NOT
// User.id (see prisma/schema/subscription.prisma — `admin AdminProfile
// @relation(fields: [adminId], references: [id])`). Every method below that
// queries Subscription must resolve the AdminProfile first; querying with
// `adminId: user.id` directly silently matches zero rows for any real
// account and throws "No active subscription found."

const resolveAdminProfileId = async (user: IRequestUser): Promise<string> =>
    getAdminId(user);

const assertSelfServiceRecoveryAllowed = async (adminId: string) => {
    const access = await TenantAccessResolver.resolve(adminId);
    if (!access.access.recoveryAllowed) {
        throw new AppError(
            status.FORBIDDEN,
            "This organization cannot use self-service subscription recovery. Please contact support.",
            { code: access.access.deniedReason, retryable: false },
        );
    }
    return access;
};

// ─── Existing: get my subscription ───────────────────────────────────────────

const getMySubscription = async (user: IRequestUser) => {
    const adminId = await resolveAdminProfileId(user);
    const now = new Date();

    const [subscription, access] = await Promise.all([
        prisma.subscription
            .findFirstOrThrow({
                where: { adminId },
                orderBy: { createdAt: "desc" },
                include: {
                    plan: true,
                    subscriptionPlan: true,
                    coupon: true,
                    billingHistory: { orderBy: { createdAt: "desc" }, take: 5 },
                    pendingPlanChanges: {
                        where: {
                            OR: [
                                { status: PendingPlanChangeStatus.UNDER_REVIEW },
                                {
                                    status: { in: [PendingPlanChangeStatus.AWAITING_PAYMENT, PendingPlanChangeStatus.REJECTED] },
                                    expiresAt: { gt: now },
                                },
                            ],
                        },
                        orderBy: { createdAt: "desc" },
                        take: 1,
                        include: {
                            targetPlan: { include: { subscriptionPlan: true } },
                            coupon: true,
                            billingHistory: { orderBy: { createdAt: "desc" }, take: 1 },
                        },
                    },
                },
            })
            .catch((err) => {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
                    throw new AppError(status.NOT_FOUND, "No active subscription found.");
                }
                throw err;
            }),
        TenantAccessResolver.resolve(adminId),
    ]);

    const endsAt = subscription.isTrial
        ? subscription.trialEndsAt
        : subscription.currentPeriodEnd;
    const remainingMs = endsAt ? Math.max(0, endsAt.getTime() - now.getTime()) : null;
    const lifecycleState = getLifecycleState(subscription, access.access.deniedReason);
    const usage = await getSubscriptionUsageSnapshot(adminId, access.resourceLimits.effective, now);

    // Preserve the historical subscription response while exposing the exact
    // canonical access/entitlement decision used by middleware, public routes,
    // workers and Super Admin. Frontends should authorize by stable keys here.
    return {
        ...subscription,
        organizationId: access.organizationId,
        access: access.access,
        effectiveEntitlements: access.effectiveEntitlements,
        baseEntitlements: access.baseEntitlements,
        paidExtras: access.paidExtras,
        tenantOverrides: access.tenantOverrides,
        resourceLimits: access.resourceLimits.effective,
        serverTime: now.toISOString(),
        lifecycle: {
            state: lifecycleState,
            isTrial: subscription.isTrial,
            startsAt: subscription.currentPeriodStart?.toISOString() ?? null,
            endsAt: endsAt?.toISOString() ?? null,
            daysRemaining: remainingMs === null ? null : Math.ceil(remainingMs / DAY_MS),
            secondsRemaining: remainingMs === null ? null : Math.ceil(remainingMs / 1000),
            trialPlanName: subscription.isTrial ? subscription.subscriptionPlan.name : null,
            dashboardAllowed: access.access.dashboardAllowed,
            recoveryAllowed: access.access.recoveryAllowed,
            deniedReason: access.access.deniedReason,
        },
        usage,
        effectiveAccess: access,
    };
};

// ─── Existing: create trial subscription ─────────────────────────────────────

type SubscriptionDb = Prisma.TransactionClient | typeof prisma;

interface CreateTrialSubscriptionOptions {
    db?: SubscriptionDb;
    trialDays?: number;
    skipExistingCheck?: boolean;
    preloadedPlan?: { id: string; subscriptionPlanId: string };
}

const createTrialSubscription = async (
    adminId: string,
    options: CreateTrialSubscriptionOptions = {},
) => {
    // If this helper is ever called outside an existing transaction, create a
    // transaction so the advisory lock below covers both the history check and
    // insert. This closes the double-provisioning race from concurrent repair
    // or retry requests. Fresh account provisioning already supplies `db: tx`
    // and `skipExistingCheck: true` because the AdminProfile is created in the
    // same canonical registration transaction.
    if (!options.skipExistingCheck && (!options.db || options.db === prisma)) {
        return prisma.$transaction(
            async (tx) =>
                createTrialSubscription(adminId, {
                    ...options,
                    db: tx,
                }),
            { maxWait: 10_000, timeout: 20_000 },
        );
    }

    const db = options.db ?? prisma;

    if (!options.skipExistingCheck) {
        await acquireExtendedTextTransactionAdvisoryLock(
            db,
            `subscription-trial-provision:${adminId}`,
        );
    }

    // Fresh registration creates the AdminProfile in the same transaction, so
    // an active subscription cannot already exist. Skip that defensive lookup
    // only for this trusted internal path; every other caller keeps the guard.
    const [plan, existing] = await Promise.all([
        options.preloadedPlan
            ? Promise.resolve(options.preloadedPlan)
            : db.plan.findFirst({
                where: {
                    subscriptionPlan: { name: SubscriptionName.GROWTH },
                    interval: SubscriptionPlanInterval.MONTHLY,
                },
                select: { id: true, subscriptionPlanId: true },
            }),
        options.skipExistingCheck
            ? Promise.resolve(null)
            : db.subscription.findFirst({
                // A trial is an account-level onboarding benefit, not an
                // "ACTIVE row" benefit. Any existing subscription history
                // means this tenant has already been provisioned and must not
                // receive another automatic trial after expiry/cancellation.
                where: { adminId },
                orderBy: { createdAt: "desc" },
                select: { id: true, status: true, isTrial: true, trialEndsAt: true },
            }),
    ]);

    if (!plan) {
        throw new AppError(status.NOT_FOUND, "Default trial plan not found.");
    }
    if (existing) {
        throw new AppError(
            status.CONFLICT,
            "This account already has subscription history and cannot receive another automatic trial.",
            { code: "TRIAL_ALREADY_PROVISIONED", retryable: false },
        );
    }

    const now = new Date();
    let trialDays = options.trialDays;
    if (trialDays == null) {
        const platformConfig = await getPlatformConfig().catch(
            () => null as null | { defaultTrialDays: number },
        );
        trialDays = platformConfig?.defaultTrialDays ?? FALLBACK_TRIAL_DAYS;
    }
    const trialEndsAt = new Date(
        now.getTime() + trialDays * 24 * 60 * 60 * 1000,
    );

    return db.subscription.create({
        data: {
            adminId,
            planId: plan.id,
            subscriptionPlanId: plan.subscriptionPlanId,
            isTrial: true,
            status: SubscriptionStatus.ACTIVE,
            trialEndsAt,
            currentPeriodStart: now,
            currentPeriodEnd: trialEndsAt,
            totalCost: new Decimal(0),
            extraStaff: 0,
            extraClient: 0,
            extraBookingsPerMonth: 0,
        },
        include: { plan: true, subscriptionPlan: true },
    });
};

// ─── Phase 6: pending plan-change checkout ────────────────────────────────────

const ACTIVE_CHECKOUT_STATUSES = [
    PendingPlanChangeStatus.AWAITING_PAYMENT,
    PendingPlanChangeStatus.UNDER_REVIEW,
] as const;

const UNRESOLVED_CHECKOUT_STATUSES = [
    ...ACTIVE_CHECKOUT_STATUSES,
    PendingPlanChangeStatus.REJECTED,
] as const;

const calculatePlanCheckoutAmount = (
    price: number,
    planDiscount: number,
    planDiscountEndDate: Date | null,
    couponDiscountType: "PERCENTAGE" | "FIXED" | null,
    couponDiscountValue: number,
) => {
    let total = price;
    if (
        planDiscount > 0 &&
        (!planDiscountEndDate || planDiscountEndDate > new Date())
    ) {
        total -= (total * planDiscount) / 100;
    }
    if (couponDiscountType === "PERCENTAGE") {
        total -= (total * couponDiscountValue) / 100;
    } else if (couponDiscountType === "FIXED") {
        total -= couponDiscountValue;
    }
    return Math.max(0, Number(total.toFixed(2)));
};

const changePlan = async (
    user: IRequestUser,
    payload: { planId: string; couponCode?: string },
) => {
    const adminId = await resolveAdminProfileId(user);
    await assertSelfServiceRecoveryAllowed(adminId);
    const couponCode = payload.couponCode?.trim().toUpperCase() || undefined;

    const [targetPlan, current] = await Promise.all([
        prisma.plan.findUnique({
            where: { id: payload.planId },
            include: { subscriptionPlan: true },
        }),
        prisma.subscription.findFirst({
            where: { adminId },
            orderBy: { createdAt: "desc" },
        }),
    ]);

    if (!targetPlan || !targetPlan.subscriptionPlan.isActive) {
        throw new AppError(status.NOT_FOUND, "That subscription plan is no longer available.", {
            code: "SUBSCRIPTION_PLAN_UNAVAILABLE",
            retryable: false,
        });
    }
    if (!current) {
        throw new AppError(status.NOT_FOUND, "No subscription found for this account.");
    }
    if (current.status === SubscriptionStatus.SUSPENDED) {
        throw new AppError(
            status.FORBIDDEN,
            "This subscription is suspended. Contact support before changing plans.",
            { code: "SUBSCRIPTION_SUSPENDED", retryable: false },
        );
    }

    const now = new Date();
    const currentlyPaidAndActive =
        current.status === SubscriptionStatus.ACTIVE &&
        !current.isTrial &&
        (!current.currentPeriodEnd || current.currentPeriodEnd > now);
    if (currentlyPaidAndActive && current.planId === targetPlan.id) {
        throw new AppError(status.BAD_REQUEST, "You are already on this billing plan.", {
            code: "SUBSCRIPTION_PLAN_ALREADY_ACTIVE",
            retryable: false,
        });
    }

    let coupon: Awaited<ReturnType<typeof prisma.coupon.findFirst>> = null;
    if (couponCode) {
        coupon = await prisma.coupon.findFirst({
            where: {
                code: couponCode,
                isActive: true,
                AND: [
                    { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
                    { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
                ],
            },
        });
        if (!coupon) {
            throw new AppError(status.BAD_REQUEST, "Invalid or expired coupon code.", {
                code: "COUPON_INVALID",
                fieldErrors: { couponCode: "This coupon is invalid or expired." },
            });
        }
    }

    const lockKey = `subscription-checkout:${current.id}`;
    return prisma.$transaction(async (tx) => {
        await acquireExtendedTextTransactionAdvisoryLock(tx, lockKey);

        // Legacy checkouts (created before PendingPlanChange existed) moved the
        // live subscription into PENDING_PAYMENT. Do not allow a second checkout
        // while one of those payment proofs is still awaiting review. Keeping
        // this check inside the same advisory lock closes double-click/race gaps.
        const freshSubscription = await tx.subscription.findUnique({
            where: { id: current.id },
            select: { status: true },
        });
        if (freshSubscription?.status === SubscriptionStatus.PENDING_PAYMENT) {
            const legacyProofUnderReview = await tx.billingHistory.findFirst({
                where: {
                    subscriptionId: current.id,
                    status: "PENDING",
                    paymentProofUrl: { not: null },
                    planChangeId: null,
                },
                select: { id: true },
            });
            if (legacyProofUnderReview) {
                throw new AppError(
                    status.CONFLICT,
                    "A payment proof is already under review. Wait for it to be reviewed before starting another plan change.",
                    { code: "PAYMENT_PROOF_ALREADY_PENDING", retryable: false },
                );
            }
        }

        // A checkout only reserves pricing/coupon capacity for a bounded time.
        // Under-review proofs are never auto-expired while a super-admin is
        // deciding them.
        await tx.pendingPlanChange.updateMany({
            where: {
                subscriptionId: current.id,
                status: {
                    in: [
                        PendingPlanChangeStatus.AWAITING_PAYMENT,
                        PendingPlanChangeStatus.REJECTED,
                    ],
                },
                expiresAt: { lte: now },
            },
            data: { status: PendingPlanChangeStatus.CANCELLED, reviewedAt: now },
        });

        const existing = await tx.pendingPlanChange.findFirst({
            where: {
                subscriptionId: current.id,
                status: { in: [...UNRESOLVED_CHECKOUT_STATUSES] },
            },
            orderBy: { createdAt: "desc" },
            include: {
                targetPlan: { include: { subscriptionPlan: true } },
                coupon: true,
                billingHistory: { orderBy: { createdAt: "desc" }, take: 1 },
            },
        });

        if (existing?.status === PendingPlanChangeStatus.UNDER_REVIEW) {
            if (
                existing.targetPlanId === targetPlan.id &&
                (existing.coupon?.code ?? undefined) === couponCode
            ) {
                return existing;
            }
            throw new AppError(
                status.CONFLICT,
                "A payment proof is already under review. Wait for it to be reviewed before starting another plan change.",
                { code: "PLAN_CHANGE_UNDER_REVIEW", retryable: false },
            );
        }

        if (
            (existing?.status === PendingPlanChangeStatus.AWAITING_PAYMENT ||
                existing?.status === PendingPlanChangeStatus.REJECTED) &&
            existing.targetPlanId === targetPlan.id &&
            (existing.coupon?.code ?? undefined) === couponCode
        ) {
            return existing;
        }

        if (
            existing?.status === PendingPlanChangeStatus.AWAITING_PAYMENT ||
            existing?.status === PendingPlanChangeStatus.REJECTED
        ) {
            await tx.pendingPlanChange.update({
                where: { id: existing.id },
                data: { status: PendingPlanChangeStatus.CANCELLED, reviewedAt: now },
            });
        }

        let couponDiscountType: "PERCENTAGE" | "FIXED" | null = null;
        let couponDiscountValue = 0;
        if (coupon) {
            const couponLockKey = `subscription-coupon:${coupon.id}`;
            await acquireExtendedTextTransactionAdvisoryLock(tx, couponLockKey);

            const freshCoupon = await tx.coupon.findUnique({ where: { id: coupon.id } });
            if (
                !freshCoupon ||
                !freshCoupon.isActive ||
                (freshCoupon.validFrom && freshCoupon.validFrom > now) ||
                (freshCoupon.validUntil && freshCoupon.validUntil < now)
            ) {
                throw new AppError(status.BAD_REQUEST, "Invalid or expired coupon code.", {
                    code: "COUPON_INVALID",
                    fieldErrors: { couponCode: "This coupon is invalid or expired." },
                });
            }

            const alreadyUsed = await tx.couponUsage.findUnique({
                where: { couponId_adminId: { couponId: freshCoupon.id, adminId } },
            });
            if (alreadyUsed) {
                throw new AppError(status.BAD_REQUEST, "You have already used this coupon.", {
                    code: "COUPON_ALREADY_USED",
                    fieldErrors: { couponCode: "You have already used this coupon." },
                });
            }

            if (freshCoupon.maxUses !== null) {
                const reserved = await tx.pendingPlanChange.count({
                    where: {
                        couponId: freshCoupon.id,
                        OR: [
                            { status: PendingPlanChangeStatus.UNDER_REVIEW },
                            {
                                status: {
                                    in: [
                                        PendingPlanChangeStatus.AWAITING_PAYMENT,
                                        PendingPlanChangeStatus.REJECTED,
                                    ],
                                },
                                expiresAt: { gt: now },
                            },
                        ],
                    },
                });
                if (freshCoupon.usedCount + reserved >= freshCoupon.maxUses) {
                    throw new AppError(status.GONE, "This coupon has reached its usage limit.", {
                        code: "COUPON_LIMIT_REACHED",
                        fieldErrors: { couponCode: "This coupon is no longer available." },
                    });
                }
            }

            if (
                freshCoupon.discountType === "FIXED" &&
                freshCoupon.currency &&
                freshCoupon.currency !== targetPlan.subscriptionPlan.currency
            ) {
                throw new AppError(status.BAD_REQUEST, `This coupon is valid for ${freshCoupon.currency} plans only.`, {
                    code: "COUPON_CURRENCY_MISMATCH",
                    fieldErrors: { couponCode: `Choose a coupon for ${targetPlan.subscriptionPlan.currency}.` },
                });
            }

            couponDiscountType = freshCoupon.discountType;
            couponDiscountValue = Number(freshCoupon.discountValue);
        }

        const quotedAmount = calculatePlanCheckoutAmount(
            Number(targetPlan.price),
            Number(targetPlan.discount ?? 0),
            targetPlan.discountEndDate,
            couponDiscountType,
            couponDiscountValue,
        );

        return tx.pendingPlanChange.create({
            data: {
                subscriptionId: current.id,
                targetPlanId: targetPlan.id,
                couponId: coupon?.id ?? null,
                quotedAmount: new Decimal(quotedAmount.toFixed(2)),
                currency: targetPlan.subscriptionPlan.currency,
                status: PendingPlanChangeStatus.AWAITING_PAYMENT,
                expiresAt: new Date(now.getTime() + CHECKOUT_TTL_MS),
            },
            include: {
                targetPlan: { include: { subscriptionPlan: true } },
                coupon: true,
                billingHistory: { orderBy: { createdAt: "desc" }, take: 1 },
            },
        });
    });
};

const cancelPendingPlanChange = async (user: IRequestUser) => {
    const adminId = await resolveAdminProfileId(user);
    await assertSelfServiceRecoveryAllowed(adminId);
    const current = await prisma.subscription.findFirst({
        where: { adminId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
    });
    if (!current) throw new AppError(status.NOT_FOUND, "No subscription found.");

    const lockKey = `subscription-checkout:${current.id}`;
    return prisma.$transaction(async (tx) => {
        await acquireExtendedTextTransactionAdvisoryLock(tx, lockKey);
        const pending = await tx.pendingPlanChange.findFirst({
            where: {
                subscriptionId: current.id,
                status: {
                    in: [
                        PendingPlanChangeStatus.AWAITING_PAYMENT,
                        PendingPlanChangeStatus.REJECTED,
                        PendingPlanChangeStatus.UNDER_REVIEW,
                    ],
                },
            },
            orderBy: { createdAt: "desc" },
        });
        if (!pending) {
            throw new AppError(status.NOT_FOUND, "No pending plan change found.", {
                code: "PLAN_CHANGE_NOT_FOUND",
            });
        }
        if (pending.status === PendingPlanChangeStatus.UNDER_REVIEW) {
            throw new AppError(
                status.CONFLICT,
                "Payment is already under review and cannot be cancelled from the tenant portal.",
                { code: "PLAN_CHANGE_UNDER_REVIEW", retryable: false },
            );
        }
        return tx.pendingPlanChange.update({
            where: { id: pending.id },
            data: { status: PendingPlanChangeStatus.CANCELLED, reviewedAt: new Date() },
        });
    });
};

// ─── New: cancel at period end ────────────────────────────────────────────────

const cancelAtPeriodEnd = async (user: IRequestUser) => {
    const adminId = await resolveAdminProfileId(user);
    await assertSelfServiceRecoveryAllowed(adminId);

    const current = await prisma.subscription.findFirst({
        where: { adminId, status: SubscriptionStatus.ACTIVE },
    });
    if (!current) {
        throw new AppError(status.NOT_FOUND, "No active subscription found.");
    }
    if (current.cancelAtPeriodEnd) {
        throw new AppError(
            status.BAD_REQUEST,
            "Subscription is already scheduled for cancellation.",
        );
    }

    const updated = await prisma.subscription.update({
        where: { id: current.id },
        data: { cancelAtPeriodEnd: true },
        include: { plan: true, subscriptionPlan: true },
    });
    await invalidateSubscriptionAccessCache(user.id);
    return updated;
};

// ─── New: undo cancellation ───────────────────────────────────────────────────

const resumeSubscription = async (user: IRequestUser) => {
    const adminId = await resolveAdminProfileId(user);
    await assertSelfServiceRecoveryAllowed(adminId);

    const current = await prisma.subscription.findFirst({
        where: { adminId, status: SubscriptionStatus.ACTIVE },
    });
    if (!current) {
        throw new AppError(status.NOT_FOUND, "No active subscription found.");
    }
    if (!current.cancelAtPeriodEnd) {
        throw new AppError(
            status.BAD_REQUEST,
            "Subscription is not scheduled for cancellation.",
        );
    }

    const updated = await prisma.subscription.update({
        where: { id: current.id },
        data: { cancelAtPeriodEnd: false },
        include: { plan: true, subscriptionPlan: true },
    });
    await invalidateSubscriptionAccessCache(user.id);
    return updated;
};

// ─── New: get billing history for current admin ───────────────────────────────

const getMyBillingHistory = async (
    user: IRequestUser,
    paginationOptions: { page?: number; limit?: number },
) => {
    const page = paginationOptions.page ?? 1;
    const limit = paginationOptions.limit ?? 10;
    const skip = (page - 1) * limit;

    const adminId = await resolveAdminProfileId(user);

    const tenantHistoryWhere = { subscription: { adminId } };
    const [total, data] = await Promise.all([
        prisma.billingHistory.count({ where: tenantHistoryWhere }),
        prisma.billingHistory.findMany({
            where: tenantHistoryWhere,
            orderBy: { createdAt: "desc" },
            skip,
            take: limit,
        }),
    ]);

    const rows = await Promise.all(data.map(async (row) => ({
        ...row,
        paymentProofUrl: row.paymentProofMediaAssetId
            ? await mediaService.getReadUrlForTenant(row.paymentProofMediaAssetId, adminId)
            : (row.paymentProofUrl?.startsWith("r2") ? null : row.paymentProofUrl),
        invoiceUrl: row.invoiceMediaAssetId
            ? await mediaService.getReadUrlForTenant(row.invoiceMediaAssetId, adminId)
            : (row.invoiceUrl?.startsWith("r2") ? null : row.invoiceUrl),
    })));
    return {
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        data: rows,
    };
};

const initiateSubscriptionProofUpload = async (
    user: IRequestUser,
    payload: { filename: string; contentType: string; size: number },
) => {
    const adminId = await resolveAdminProfileId(user);
    await assertSelfServiceRecoveryAllowed(adminId);

    // This recovery upload intentionally lives under /subscription instead of
    // the normal /media router so an expired trial can still submit proof.
    // The server hard-codes the purpose; the browser cannot use this endpoint
    // to upload arbitrary tenant media while its subscription is inactive.
    return mediaService.initiateUpload(
        {
            purpose: "SUBSCRIPTION_PROOF",
            filename: payload.filename,
            contentType: payload.contentType,
            size: payload.size,
        },
        user,
    );
};

const finalizeSubscriptionProofUpload = async (
    user: IRequestUser,
    uploadId: string,
) => {
    const adminId = await resolveAdminProfileId(user);
    await assertSelfServiceRecoveryAllowed(adminId);
    const asset = await prisma.mediaAsset.findFirst({
        where: { id: uploadId, adminId, deletedAt: null },
        select: { id: true, purpose: true },
    });

    if (!asset || asset.purpose !== "SUBSCRIPTION_PROOF") {
        throw new AppError(status.NOT_FOUND, "Subscription proof upload was not found.", {
            code: "SUBSCRIPTION_PROOF_UPLOAD_NOT_FOUND",
            retryable: false,
        });
    }

    return mediaService.finalizeUpload(uploadId, user);
};

const submitPaymentProof = async (
    user: IRequestUser,
    payload: {
        paymentProofAssetId: string;
        amount?: number;
        method: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "MANUAL";
        note?: string;
        transactionId?: string;
    },
) => {
    const { paymentProofAssetId, amount, method, note, transactionId } = payload;
    const adminId = await resolveAdminProfileId(user);
    await assertSelfServiceRecoveryAllowed(adminId);

    const sub = await prisma.subscription.findFirst({
        where: { adminId },
        orderBy: { createdAt: "desc" },
        include: { subscriptionPlan: { select: { currency: true } } },
    });
    if (!sub) throw new AppError(status.NOT_FOUND, "No subscription found.");
    const proofAsset = await mediaService.bindReadyAsset(paymentProofAssetId, user, "SUBSCRIPTION_PROOF", sub.id);
    const paymentProofUrl = `r2://${proofAsset.bucket}/${proofAsset.objectKey}`;

    try {
        const checkout = await prisma.pendingPlanChange.findFirst({
            where: {
                subscriptionId: sub.id,
                status: {
                    in: [
                        PendingPlanChangeStatus.AWAITING_PAYMENT,
                        PendingPlanChangeStatus.UNDER_REVIEW,
                        PendingPlanChangeStatus.REJECTED,
                    ],
                },
            },
            orderBy: { createdAt: "desc" },
            include: { targetPlan: { include: { subscriptionPlan: true } } },
        });

        if (checkout) {
            const expectedAmount = Number(checkout.quotedAmount);
            if (
                amount !== undefined &&
                Math.abs(Number(amount) - expectedAmount) > 0.01
            ) {
                throw new AppError(
                    status.UNPROCESSABLE_ENTITY,
                    "The payment amount does not match this checkout.",
                    {
                        code: "PAYMENT_AMOUNT_MISMATCH",
                        fieldErrors: {
                            amount: `The expected amount is ${checkout.currency} ${expectedAmount.toFixed(2)}.`,
                        },
                    },
                );
            }

            const lockKey = `subscription-checkout:${sub.id}`;
            const result = await prisma.$transaction(async (tx) => {
                await acquireExtendedTextTransactionAdvisoryLock(tx, lockKey);
                const fresh = await tx.pendingPlanChange.findUnique({
                    where: { id: checkout.id },
                    include: { targetPlan: { include: { subscriptionPlan: true } } },
                });
                if (!fresh) {
                    throw new AppError(status.NOT_FOUND, "This plan checkout no longer exists.");
                }
                if (
                    fresh.status !== PendingPlanChangeStatus.UNDER_REVIEW &&
                    fresh.expiresAt <= new Date()
                ) {
                    throw new AppError(
                        status.GONE,
                        "This plan checkout has expired. Choose the plan again to get a fresh total.",
                        { code: "PLAN_CHECKOUT_EXPIRED", retryable: false },
                    );
                }
                if (fresh.status === PendingPlanChangeStatus.UNDER_REVIEW) {
                    throw new AppError(
                        status.CONFLICT,
                        "A payment proof for this plan is already under review.",
                        { code: "PAYMENT_PROOF_ALREADY_PENDING", retryable: false },
                    );
                }
                if (
                    fresh.status !== PendingPlanChangeStatus.AWAITING_PAYMENT &&
                    fresh.status !== PendingPlanChangeStatus.REJECTED
                ) {
                    throw new AppError(status.CONFLICT, "This checkout can no longer accept payment proof.", {
                        code: "PLAN_CHANGE_NOT_PAYABLE",
                        retryable: false,
                    });
                }

                const billingRecord = await tx.billingHistory.create({
                    data: {
                        subscriptionId: sub.id,
                        amount: fresh.quotedAmount,
                        currency: fresh.currency,
                        method,
                        status: "PENDING",
                        paymentProofUrl,
                        paymentProofMediaAssetId: proofAsset.id,
                        note: note ?? null,
                        transactionId: transactionId ?? null,
                        planChangeId: fresh.id,
                    },
                });
                const pendingPlanChange = await tx.pendingPlanChange.update({
                    where: { id: fresh.id },
                    data: {
                        status: PendingPlanChangeStatus.UNDER_REVIEW,
                        submittedAt: new Date(),
                        reviewedAt: null,
                        rejectionReason: null,
                    },
                    include: {
                        targetPlan: { include: { subscriptionPlan: true } },
                        coupon: true,
                        billingHistory: { orderBy: { createdAt: "desc" }, take: 1 },
                    },
                });
                return { billingRecord, pendingPlanChange };
            });

            emitToSuperAdmins("payment-proof:submitted", {
                billingId: result.billingRecord.id,
                subscriptionId: sub.id,
                planChangeId: result.pendingPlanChange.id,
                adminId,
                amount: Number(result.billingRecord.amount),
                submittedAt: result.billingRecord.createdAt.toISOString(),
            });
            return result;
        }

        // Backward compatibility for checkouts started before Phase 6 deployed.
        // Those old records already changed Subscription.status to PENDING_PAYMENT
        // and have no PendingPlanChange row. New flows never mutate the live
        // subscription before approval. Keep the legacy fallback concurrency-safe
        // as well so retries/double-clicks cannot create two pending payments.
        if (!amount || amount <= 0) {
            throw new AppError(status.BAD_REQUEST, "A valid amount is required for this legacy payment.", {
                fieldErrors: { amount: "Enter the amount paid." },
            });
        }

        const legacyBillingRecord = await prisma.$transaction(async (tx) => {
            await acquireExtendedTextTransactionAdvisoryLock(
                tx,
                `subscription-checkout:${sub.id}`,
            );

            const freshSub = await tx.subscription.findUnique({
                where: { id: sub.id },
                select: {
                    id: true,
                    status: true,
                    isTrial: true,
                    currentPeriodEnd: true,
                    trialEndsAt: true,
                },
            });
            if (!freshSub) {
                throw new AppError(status.NOT_FOUND, "Subscription no longer exists.");
            }

            const now = new Date();
            const periodExpired = Boolean(
                freshSub.currentPeriodEnd && freshSub.currentPeriodEnd <= now,
            );
            const trialExpired = Boolean(
                freshSub.isTrial && freshSub.trialEndsAt && freshSub.trialEndsAt <= now,
            );
            const canReactivateCurrentPlan =
                freshSub.status !== SubscriptionStatus.ACTIVE || periodExpired || trialExpired;
            if (!canReactivateCurrentPlan) {
                throw new AppError(
                    status.BAD_REQUEST,
                    "Choose a subscription plan before submitting payment proof.",
                    { code: "PLAN_CHECKOUT_REQUIRED", retryable: false },
                );
            }

            const recentPending = await tx.billingHistory.findFirst({
                where: {
                    subscriptionId: sub.id,
                    status: "PENDING",
                    paymentProofUrl: { not: null },
                    planChangeId: null,
                },
                select: { id: true },
            });
            if (recentPending) {
                throw new AppError(
                    status.TOO_MANY_REQUESTS,
                    "A payment proof is already under review.",
                    { code: "PAYMENT_PROOF_ALREADY_PENDING", retryable: false },
                );
            }

            return tx.billingHistory.create({
                data: {
                    subscriptionId: sub.id,
                    amount,
                    currency: sub.subscriptionPlan.currency,
                    method,
                    status: "PENDING",
                    paymentProofUrl,
                    paymentProofMediaAssetId: proofAsset.id,
                    note: note ?? null,
                    transactionId: transactionId ?? null,
                },
            });
        });

        emitToSuperAdmins("payment-proof:submitted", {
            billingId: legacyBillingRecord.id,
            subscriptionId: sub.id,
            adminId,
            amount: Number(legacyBillingRecord.amount),
            submittedAt: legacyBillingRecord.createdAt.toISOString(),
        });
        return { billingRecord: legacyBillingRecord, pendingPlanChange: null };
    } catch (error) {
        await mediaService.deleteAssetIfUnreferencedForTenant(proofAsset.id, adminId).catch(() => undefined);
        throw error;
    }
};

export const subscriptionService = {
    getMySubscription,
    createTrialSubscription,
    changePlan,
    cancelPendingPlanChange,
    cancelAtPeriodEnd,
    resumeSubscription,
    getMyBillingHistory,
    initiateSubscriptionProofUpload,
    finalizeSubscriptionProofUpload,
    submitPaymentProof,
};
