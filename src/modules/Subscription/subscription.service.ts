import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { IRequestUser } from "../../types/requestUser.interface";

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

export const subscriptionService = {
    getMySubscription,
};
