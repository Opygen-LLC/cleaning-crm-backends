import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { Prisma, SubscriptionName, SubscriptionPlanInterval, SubscriptionStatus } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { IRequestUser } from "../../types/requestUser.interface";
import { ICreateTrialSubscription } from "./subscription.interface";
import { Decimal } from "@prisma/client/runtime/client";

const TRIAL_DAYS = 7;

const getMySubscription = async (user: IRequestUser) => {
    return await prisma.subscription
        .findFirstOrThrow({
            where: { adminId: user.id },
            include: {
                plan: true,
                subscriptionPlan: true,
                coupon: true,
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
            throw err; // re-throw unexpected errors
        });
};

const createTrialSubscription = async (adminId: string) => {
    // ✅ Parallel: find default GROWTH/MONTHLY plan + check existing subscription
    const [plan, existing] = await Promise.all([
        prisma.plan.findFirst({
            where: {
                subscriptionPlan: { name: SubscriptionName.GROWTH }, // default trial plan
                interval: SubscriptionPlanInterval.MONTHLY,
            },
            select: {
                id: true,
                subscriptionPlanId: true,
            },
        }),
        prisma.subscription.findFirst({
            where: {
                adminId,
                status: SubscriptionStatus.ACTIVE,
            },
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
    const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

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
        include: {
            plan: true,
            subscriptionPlan: true,
        },
    });
};

export const subscriptionService = {
    getMySubscription,
    createTrialSubscription,
};
