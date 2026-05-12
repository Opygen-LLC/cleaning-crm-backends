import { prisma } from "../../lib/prisma/prisma";

const getAllSubscriptionPlans = async () => {
    return await prisma.subscriptionPlan.findMany({
        include: {
            plans: true,
        },
    });
};

export const subscriptionPlanService = {
    getAllSubscriptionPlans,
};
