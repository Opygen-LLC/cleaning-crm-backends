import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
    Prisma,
    SubscriptionName,
    SubscriptionPlanInterval,
    SubscriptionStatus,
} from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { IRequestUser } from "../../types/requestUser.interface";
import { Decimal } from "@prisma/client/runtime/client";
import { getPlatformConfig } from "../../lib/utils/platformConfig";

// Fallback only — the real value is read from platform config
// (super-admin → Settings → Platform Configuration → "Default trial days")
// at the moment each trial is created, so changing the setting takes effect
// for all new signups immediately without a redeploy.
const FALLBACK_TRIAL_DAYS = 7;

// ─── Helper: resolve AdminProfile.id from the authenticated User ─────────────
// BUGFIX: Subscription.adminId is a foreign key to AdminProfile.id, NOT
// User.id (see prisma/schema/subscription.prisma — `admin AdminProfile
// @relation(fields: [adminId], references: [id])`). Every method below that
// queries Subscription must resolve the AdminProfile first; querying with
// `adminId: user.id` directly silently matches zero rows for any real
// account and throws "No active subscription found."

const resolveAdminProfileId = async (user: IRequestUser): Promise<string> => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
        select: { id: true },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found.");
    }

    return adminProfile.id;
};

// ─── Existing: get my subscription ───────────────────────────────────────────

const getMySubscription = async (user: IRequestUser) => {
    const adminId = await resolveAdminProfileId(user);

    return await prisma.subscription
        .findFirstOrThrow({
            where: { adminId },
            include: {
                plan: true,
                subscriptionPlan: true,
                coupon: true,
                billingHistory: {
                    orderBy: { createdAt: "desc" },
                    take: 5,
                },
            },
        })
        .catch((err) => {
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === "P2025"
            ) {
                throw new AppError(
                    status.NOT_FOUND,
                    "No active subscription found.",
                );
            }
            throw err;
        });
};

// ─── Existing: create trial subscription ─────────────────────────────────────

const createTrialSubscription = async (adminId: string) => {
    const [plan, existing] = await Promise.all([
        prisma.plan.findFirst({
            where: {
                subscriptionPlan: { name: SubscriptionName.GROWTH },
                interval: SubscriptionPlanInterval.MONTHLY,
            },
            select: { id: true, subscriptionPlanId: true },
        }),
        prisma.subscription.findFirst({
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
    const platformConfig = await getPlatformConfig().catch(
        () => null as null | { defaultTrialDays: number },
    );
    const trialDays = platformConfig?.defaultTrialDays ?? FALLBACK_TRIAL_DAYS;
    const trialEndsAt = new Date(
        now.getTime() + trialDays * 24 * 60 * 60 * 1000,
    );

    return prisma.subscription.create({
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

// ─── New: upgrade / downgrade to a different plan ────────────────────────────

const changePlan = async (
    user: IRequestUser,
    payload: {
        planId: string; // the target Plan (pricing tier) id
        couponCode?: string;
    },
) => {
    const { planId, couponCode } = payload;
    const adminId = await resolveAdminProfileId(user);

    // Validate target plan exists
    const targetPlan = await prisma.plan.findUnique({
        where: { id: planId },
        include: { subscriptionPlan: true },
    });
    if (!targetPlan) {
        throw new AppError(status.NOT_FOUND, "Plan not found.");
    }

    // Find current active subscription
    const current = await prisma.subscription.findFirst({
        where: { adminId, status: SubscriptionStatus.ACTIVE },
    });
    if (!current) {
        throw new AppError(
            status.NOT_FOUND,
            "No active subscription found to upgrade/downgrade.",
        );
    }

    // Resolve coupon if provided
    let couponId: string | null = null;
    if (couponCode) {
        const coupon = await prisma.coupon.findFirst({
            where: {
                code: couponCode,
                isActive: true,
                OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
            },
        });
        if (!coupon) {
            throw new AppError(
                status.BAD_REQUEST,
                "Invalid or expired coupon code.",
            );
        }
        couponId = coupon.id;
    }

    // Calculate new total cost (base price after discount)
    let newCost = Number(targetPlan.price);
    if (targetPlan.discount && Number(targetPlan.discount) > 0) {
        const discountValid =
            !targetPlan.discountEndDate ||
            new Date(targetPlan.discountEndDate) > new Date();
        if (discountValid) {
            newCost = newCost - (newCost * Number(targetPlan.discount)) / 100;
        }
    }

    const now = new Date();
    const nextPeriodEnd = new Date(now);
    // Simple: 30 days from now for monthly, 365 for yearly
    const isYearly = targetPlan.interval === SubscriptionPlanInterval.YEARLY;
    nextPeriodEnd.setDate(nextPeriodEnd.getDate() + (isYearly ? 365 : 30));

    // Manual payment system: plan change requires proof upload + super-admin approval
    // before going ACTIVE. Set PENDING_PAYMENT so the tenant is prompted to upload proof.
    const updated = await prisma.subscription.update({
        where: { id: current.id },
        data: {
            planId: targetPlan.id,
            subscriptionPlanId: targetPlan.subscriptionPlanId,
            isTrial: false,
            status: SubscriptionStatus.PENDING_PAYMENT,
            currentPeriodStart: now,
            currentPeriodEnd: nextPeriodEnd,
            cancelAtPeriodEnd: false,
            canceledAt: null,
            totalCost: new Decimal(newCost.toFixed(2)),
            couponId,
        },
        include: { plan: true, subscriptionPlan: true, coupon: true },
    });

    return updated;
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

    return prisma.subscription.update({
        where: { id: current.id },
        data: { cancelAtPeriodEnd: true },
        include: { plan: true, subscriptionPlan: true },
    });
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

    return prisma.subscription.update({
        where: { id: current.id },
        data: { cancelAtPeriodEnd: false },
        include: { plan: true, subscriptionPlan: true },
    });
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

    const subscription = await prisma.subscription.findFirst({
        where: { adminId },
        select: { id: true },
    });
    if (!subscription) {
        return { meta: { page, limit, total: 0, totalPages: 0 }, data: [] };
    }

    const [total, data] = await Promise.all([
        prisma.billingHistory.count({
            where: { subscriptionId: subscription.id },
        }),
        prisma.billingHistory.findMany({
            where: { subscriptionId: subscription.id },
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
        amount: number;
        method: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "MANUAL";
        note?: string;
        transactionId?: string;
    },
) => {
    const { paymentProofUrl, amount, method, note, transactionId } = payload;

    if (!paymentProofUrl) {
        throw new AppError(status.BAD_REQUEST, "paymentProofUrl is required.");
    }
    if (!amount || amount <= 0) {
        throw new AppError(status.BAD_REQUEST, "A valid amount is required.");
    }

    // Find admin profile from user id
    const adminId = await resolveAdminProfileId(user);

    const sub = await prisma.subscription.findFirst({
        where: { adminId },
    });
    if (!sub) {
        throw new AppError(status.NOT_FOUND, "No subscription found.");
    }

    // Prevent spamming — block if there is already a PENDING proof in the last 24h
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
            "A payment proof was already submitted in the last 24 hours. Please wait for the super admin to review it.",
        );
    }

    const [billingRecord] = await prisma.$transaction([
        prisma.billingHistory.create({
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
        }),
        prisma.subscription.update({
            where: { id: sub.id },
            data: { status: "PENDING_PAYMENT" },
        }),
    ]);

    return billingRecord;
};

export const subscriptionService = {
    getMySubscription,
    createTrialSubscription,
    changePlan,
    cancelAtPeriodEnd,
    resumeSubscription,
    getMyBillingHistory,
    submitPaymentProof,
};
