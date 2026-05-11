import { prisma } from "../../lib/prisma/prisma";
import { IRequestUser } from "../../types/requestUser.interface";

const getMySubscription = async (user: IRequestUser) => {
    return await prisma.subscription.findFirstOrThrow({
        where: { adminId: user.id },
        include: {
            plan: true,
            subscriptionPlan: true,
            coupon: true,
        },
    });
};

export const subscriptionService = {
    getMySubscription,
};
