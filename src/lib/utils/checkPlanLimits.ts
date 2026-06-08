import { startOfMonth } from "date-fns";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../prisma/prisma";

type Resource = "staff" | "client" | "booking";

/**
 * Asserts the admin hasn't exceeded their plan cap for the given resource.
 * Throws a 402 AppError when the limit is reached.
 *
 * Call this from service create functions BEFORE inserting the new record.
 */
export async function assertWithinLimit(
    adminId: string,
    resource: Resource,
): Promise<void> {
    const sub = await prisma.subscription.findFirst({
        where: { adminId },
        include: { plan: true },
        orderBy: { createdAt: "desc" },
    });

    // No subscription on file → no cap applied (free trial / superadmin created account)
    if (!sub) return;

    const cap: Record<Resource, number> = {
        staff: (sub.plan.maxStaff ?? Infinity) + sub.extraStaff,
        client: (sub.plan.maxClient ?? Infinity) + sub.extraClient,
        booking:
            (sub.plan.maxBookingsPerMonth ?? Infinity) +
            sub.extraBookingsPerMonth,
    };

    const countFns: Record<Resource, () => Promise<number>> = {
        staff: () => prisma.staffProfile.count({ where: { adminId } }),
        client: () => prisma.client.count({ where: { adminId } }),
        booking: () =>
            prisma.booking.count({
                where: {
                    adminId,
                    createdAt: { gte: startOfMonth(new Date()) },
                },
            }),
    };

    const count = await countFns[resource]();

    if (count >= cap[resource]) {
        throw new AppError(
            402,
            `Plan limit reached for ${resource}. Upgrade your plan to add more.`,
        );
    }
}
