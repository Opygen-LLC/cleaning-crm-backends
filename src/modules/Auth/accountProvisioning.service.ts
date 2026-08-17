import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import { PROVISIONING_TRANSACTION_OPTIONS } from "../../lib/prisma/transactionPolicy";
import { adminService } from "../Admin/admin.service";
import { subscriptionService } from "../Subscription/subscription.service";
import { WebsiteProvisioningService } from "../Website/websiteProvisioning.service";
import { WebsiteHostResolverService } from "../Website/websiteHostResolver.service";

export interface ProvisionRegisteredAdminInput {
  userId: string;
  businessName: string;
  trialDays: number;
}

/**
 * Creates every tenant-owned record required by a fresh registration in one
 * database transaction.
 *
 * Ordering is intentional and is the Phase-1 registration contract:
 *   AdminProfile
 *     -> reserve unique subdomain
 *     -> BusinessWebsite + default pages + revision #1
 *     -> trial subscription
 *
 * Subdomain reservation is protected by transaction-scoped advisory locks in
 * WebsiteProvisioningService, so the reservation cannot escape if a later
 * website/trial write fails. Better Auth's User/Account rows are created before
 * this transaction; auth.service compensates those external writes if this
 * function rejects.
 */
const provisionRegisteredAdmin = async (input: ProvisionRegisteredAdminInput) => {
  const result = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const admin = await adminService.createAdmin(
        { userId: input.userId, businessName: input.businessName },
        tx,
      );

      const { website } = await WebsiteProvisioningService.provisionDefaultWebsiteForAdminTx(
        tx,
        {
          adminId: admin.id,
          businessName: input.businessName,
          createdByUserId: input.userId,
        },
      );

      // Keep trial creation inside the same transaction. If the default plan is
      // misconfigured or the subscription write fails, AdminProfile + website +
      // pages + revision + subdomain allocation are all rolled back together.
      const subscription = await subscriptionService.createTrialSubscription(admin.id, {
        db: tx,
        trialDays: input.trialDays,
      });

      return { admin, website, subscription };
    },
    PROVISIONING_TRANSACTION_OPTIONS,
  );

  // Commit first, then invalidate any short negative wildcard-host cache entry
  // that may exist for the newly reserved label. Routing cache is never part
  // of the registration transaction/source of truth.
  await WebsiteHostResolverService.invalidateSubdomains([result.website.subdomain]);

  // Registration exposes only the stable website identity. Do not leak the
  // full draft snapshot/pages/revisions from the provisioning transaction.
  // WEBSITE_BASE_DOMAIN is optional in local development, so publicUrl is null
  // until wildcard website hosting is configured.
  return {
    adminProfile: result.admin,
    subscription: result.subscription,
    website: {
      id: result.website.id,
      subdomain: result.website.subdomain,
      status: result.website.status,
      publicUrl: WEBSITE_BASE_DOMAIN
        ? `https://${result.website.subdomain}.${WEBSITE_BASE_DOMAIN}`
        : null,
    },
  };
};

export const AccountProvisioningService = {
  provisionRegisteredAdmin,
};
