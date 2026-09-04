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

// Fallback only — the real value is read from platform config
// (super-admin → Settings → Platform Configuration → "Default trial days")
// at the moment each trial is created, so changing the setting takes effect
// for all new signups immediately without a redeploy.
const FALLBACK_TRIAL_DAYS = 7;
const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Helper: resolve AdminProfile.id from the authenticated User ─────────────
// BUGFIX: Subscription.adminId is a foreign key to AdminProfile.id, NOT
// User.id (see prisma/schema/subscription.prisma — `admin AdminProfile
// @relation(fields: [adminId], references: [id])`). Every method below that
// queries Subscription must resolve the AdminProfile first; querying with
// `adminId: user.id` directly silently matches zero rows for any real
// account and throws "No active subscription found."

const resolveAdminProfileId = async (user: IRequestUser): Promise<string> =>
    getAdminId(user);

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
    const db = options.db ?? prisma;

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
                where: { adminId, status: SubscriptionStatus.ACTIVE },
                select: { id: true },
            }),
    ]);

    if (!plan) {
        throw new AppError(status.NOT_FOUND, "Default trial plan not found.");
    }
    if (existing) {
        throw new AppError(
            status.BAD_REQUEST,
            "Admin already has an active subscription.",
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

    return {
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        data,
    };
};

const submitPaymentProof = async (
    user: IRequestUser,
    payload: {
        paymentProofUrl: string;
        amount?: number;
        method: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "MANUAL";
        note?: string;
        transactionId?: string;
    },
) => {
    const { paymentProofUrl, amount, method, note, transactionId } = payload;
    const adminId = await resolveAdminProfileId(user);

    const sub = await prisma.subscription.findFirst({
        where: { adminId },
        orderBy: { createdAt: "desc" },
    });
    if (!sub) throw new AppError(status.NOT_FOUND, "No subscription found.");

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
    // subscription before approval.
    const periodExpired = Boolean(
        sub.currentPeriodEnd && sub.currentPeriodEnd <= new Date(),
    );
    const trialExpired = Boolean(sub.isTrial && sub.trialEndsAt && sub.trialEndsAt <= new Date());
    const canReactivateCurrentPlan =
        sub.status !== SubscriptionStatus.ACTIVE || periodExpired || trialExpired;
    if (!canReactivateCurrentPlan) {
        throw new AppError(
            status.BAD_REQUEST,
            "Choose a subscription plan before submitting payment proof.",
            { code: "PLAN_CHECKOUT_REQUIRED", retryable: false },
        );
    }
    if (!amount || amount <= 0) {
        throw new AppError(status.BAD_REQUEST, "A valid amount is required for this legacy payment.", {
            fieldErrors: { amount: "Enter the amount paid." },
        });
    }

    const recentPending = await prisma.billingHistory.findFirst({
        where: {
            subscriptionId: sub.id,
            status: "PENDING",
            paymentProofUrl: { not: null },
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
    });
    if (recentPending) {
        throw new AppError(
            status.TOO_MANY_REQUESTS,
            "A payment proof is already under review.",
            { code: "PAYMENT_PROOF_ALREADY_PENDING", retryable: false },
        );
    }

    const billingRecord = await prisma.billingHistory.create({
        data: {
            subscriptionId: sub.id,
            amount,
            currency: "USD",
            method,
            status: "PENDING",
            paymentProofUrl,
            note: note ?? null,
            transactionId: transactionId ?? null,
        },
    });

    emitToSuperAdmins("payment-proof:submitted", {
        billingId: billingRecord.id,
        subscriptionId: sub.id,
        adminId,
        amount: Number(billingRecord.amount),
        submittedAt: billingRecord.createdAt.toISOString(),
    });
    return { billingRecord, pendingPlanChange: null };
};

export const subscriptionService = {
    getMySubscription,
    createTrialSubscription,
    changePlan,
    cancelPendingPlanChange,
    cancelAtPeriodEnd,
    resumeSubscription,
    getMyBillingHistory,
    submitPaymentProof,
};
