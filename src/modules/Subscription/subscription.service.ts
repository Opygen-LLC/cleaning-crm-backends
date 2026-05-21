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

const TRIAL_DAYS = 7;

// ─── Existing: get my subscription ───────────────────────────────────────────

const getMySubscription = async (user: IRequestUser) => {
  return await prisma.subscription
    .findFirstOrThrow({
      where: { adminId: user.id },
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
        throw new AppError(status.NOT_FOUND, "No active subscription found.");
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
  const trialEndsAt = new Date(
    now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
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
    where: { adminId: user.id, status: SubscriptionStatus.ACTIVE },
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
        OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
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
  const isYearly =
    targetPlan.interval === SubscriptionPlanInterval.YEARLY;
  nextPeriodEnd.setDate(nextPeriodEnd.getDate() + (isYearly ? 365 : 30));

  const updated = await prisma.subscription.update({
    where: { id: current.id },
    data: {
      planId: targetPlan.id,
      subscriptionPlanId: targetPlan.subscriptionPlanId,
      isTrial: false,
      status: SubscriptionStatus.ACTIVE,
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
  const current = await prisma.subscription.findFirst({
    where: { adminId: user.id, status: SubscriptionStatus.ACTIVE },
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
  const current = await prisma.subscription.findFirst({
    where: { adminId: user.id, status: SubscriptionStatus.ACTIVE },
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

  const subscription = await prisma.subscription.findFirst({
    where: { adminId: user.id },
    select: { id: true },
  });
  if (!subscription) {
    return { meta: { page, limit, total: 0, totalPage: 0 }, data: [] };
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
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data,
  };
};

export const subscriptionService = {
  getMySubscription,
  createTrialSubscription,
  changePlan,
  cancelAtPeriodEnd,
  resumeSubscription,
  getMyBillingHistory,
};
