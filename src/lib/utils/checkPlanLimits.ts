import { startOfMonth } from "date-fns";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../prisma/prisma";
import { TenantEntitlementService } from "../../modules/SuperAdmin/tenantEntitlement.service";

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
    const limits = await TenantEntitlementService.getEffectiveResourceLimits(adminId);

    // null means unlimited/unmetered. Overrides are already folded into these
    // effective limits, including expiry fallback to the underlying plan.
    const cap: Record<Resource, number | null> = {
        staff: limits.staff,
        client: limits.clients,
        booking: limits.monthlyBookings,
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

    const resourceCap = cap[resource];
    if (resourceCap !== null && count >= resourceCap) {
        throw new AppError(
            402,
            `Plan limit reached for ${resource}. Upgrade your plan to add more.`,
        );
    }
}
