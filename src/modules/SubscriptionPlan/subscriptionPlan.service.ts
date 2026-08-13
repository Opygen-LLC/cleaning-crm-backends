import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { normalizeSubscriptionPlanFeatures } from "../../lib/utils/subscriptionPlanFeatures";

const serialisePlan = <T extends { features: unknown }>(plan: T) => ({
    ...plan,
    features: normalizeSubscriptionPlanFeatures(plan.features),
});

const getAllSubscriptionPlans = async () => {
    const plans = await prisma.subscriptionPlan.findMany({
        where: { isActive: true },
        include: { plans: true },
    });

    const rank: Record<string, number> = {
        STARTER: 0,
        GROWTH: 1,
        PRO: 2,
        CUSTOM: 3,
    };

    return plans
        .map(serialisePlan)
        .sort((a, b) => (rank[a.name] ?? 99) - (rank[b.name] ?? 99));
};

const getSubscriptionPlanById = async (id: string) => {
    const plan = await prisma.subscriptionPlan.findFirst({
        where: { id, isActive: true },
        include: { plans: true },
    });
    if (!plan) {
        throw new AppError(status.NOT_FOUND, "Subscription plan not found.");
    }
    return serialisePlan(plan);
};

export const subscriptionPlanService = {
    getAllSubscriptionPlans,
    getSubscriptionPlanById,
};
