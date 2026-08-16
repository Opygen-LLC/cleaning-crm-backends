import { prisma } from "../../lib/prisma/prisma";
import { adminService } from "../Admin/admin.service";
import { subscriptionService } from "../Subscription/subscription.service";
import { WebsiteProvisioningService } from "../Website/websiteProvisioning.service";

export interface ProvisionRegisteredAdminInput {
  userId: string;
  businessName: string;
  trialDays: number;
}

/**
 * Creates every tenant-owned record required by a fresh registration in one
 * database transaction. The Better Auth user is created before this function;
 * callers must compensate by deleting that user if this transaction fails.
 */
const provisionRegisteredAdmin = async (input: ProvisionRegisteredAdminInput) => {
  return prisma.$transaction(async (tx: any) => {
    const admin = await adminService.createAdmin(
      { userId: input.userId, businessName: input.businessName },
      tx,
    );

    const { website } = await WebsiteProvisioningService.provisionDefaultWebsiteForAdminTx(tx, {
      adminId: admin.id,
      businessName: input.businessName,
      createdByUserId: input.userId,
    });

    const subscription = await subscriptionService.createTrialSubscription(admin.id, {
      db: tx,
      trialDays: input.trialDays,
    });

    return { admin, website, subscription };
  });
};

export const AccountProvisioningService = {
  provisionRegisteredAdmin,
};
