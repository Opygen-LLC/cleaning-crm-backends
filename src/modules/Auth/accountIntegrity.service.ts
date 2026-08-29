import status from "http-status";
import { AccountStatus, SubscriptionStatus, UserRole } from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import logger from "../../lib/logger";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { prisma } from "../../lib/prisma/prisma";
import { PROVISIONING_TRANSACTION_OPTIONS } from "../../lib/prisma/transactionPolicy";
import { getPlatformConfig } from "../../lib/utils/platformConfig";
import { subscriptionService } from "../Subscription/subscription.service";
import { WebsiteHostResolverService } from "../Website/websiteHostResolver.service";
import { WebsiteProvisioningService } from "../Website/websiteProvisioning.service";

export type AdminProvisioningIssueCode =
  | "ADMIN_PROFILE_MISSING"
  | "SUBSCRIPTION_PROVISIONING_INCOMPLETE"
  | "WEBSITE_PROVISIONING_INCOMPLETE";

export interface AdminProvisioningInspection {
  userId: string;
  eligible: boolean;
  healthy: boolean;
  adminId: string | null;
  issues: AdminProvisioningIssueCode[];
}

export interface AdminProvisioningRepairResult extends AdminProvisioningInspection {
  repaired: boolean;
  actions: Array<"ADMIN_PROFILE_CREATED" | "TRIAL_SUBSCRIPTION_CREATED" | "BUSINESS_WEBSITE_CREATED">;
}

const repairLockKey = (userId: string) => `admin-provisioning-integrity:${userId}`;

const safeBusinessName = (name: string, email: string) => {
  const trimmed = name.trim();
  if (trimmed) return trimmed;
  const localPart = email.split("@")[0]?.trim();
  return localPart || "Business";
};

const provisioningError = (code: AdminProvisioningIssueCode) => {
  switch (code) {
    case "ADMIN_PROFILE_MISSING":
      return new AppError(status.CONFLICT, "Account provisioning is not complete yet.", {
        code,
        retryable: true,
      });
    case "SUBSCRIPTION_PROVISIONING_INCOMPLETE":
      return new AppError(status.CONFLICT, "Subscription provisioning is not complete yet.", {
        code,
        retryable: true,
      });
    case "WEBSITE_PROVISIONING_INCOMPLETE":
      return new AppError(status.CONFLICT, "Website provisioning is not complete yet.", {
        code,
        retryable: true,
      });
  }
};

/**
 * Read-only structural invariant check for already-active, verified ADMIN users.
 *
 * IMPORTANT: this checks for the existence of *any* subscription row. Expired,
 * cancelled or suspended subscriptions are structurally valid history and must
 * never be replaced by a fresh trial simply because access is currently locked.
 */
const inspectActiveAdminProvisioning = async (
  userId: string,
): Promise<AdminProvisioningInspection> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      status: true,
      emailVerified: true,
      admin: {
        select: {
          id: true,
          businessWebsite: { select: { id: true } },
          subscription: { select: { id: true }, take: 1 },
        },
      },
    },
  });

  const eligible = Boolean(
    user &&
      user.role === UserRole.ADMIN &&
      user.status === AccountStatus.ACTIVE &&
      user.emailVerified,
  );

  if (!user || !eligible) {
    return {
      userId,
      eligible: false,
      healthy: true,
      adminId: user?.admin?.id ?? null,
      issues: [],
    };
  }

  const issues: AdminProvisioningIssueCode[] = [];
  if (!user.admin) {
    issues.push("ADMIN_PROFILE_MISSING");
  } else {
    if (user.admin.subscription.length === 0) {
      issues.push("SUBSCRIPTION_PROVISIONING_INCOMPLETE");
    }
    if (!user.admin.businessWebsite) {
      issues.push("WEBSITE_PROVISIONING_INCOMPLETE");
    }
  }

  return {
    userId,
    eligible: true,
    healthy: issues.length === 0,
    adminId: user.admin?.id ?? null,
    issues,
  };
};


export interface EmailVerificationCandidate {
  id: string;
  role: UserRole;
  hasCredentialAccount: boolean;
}

/**
 * Verification preflight in one SQL round trip. For ADMIN accounts this also
 * validates the complete tenant graph before the OTP is consumed, avoiding the
 * previous user/account lookup followed by a second readiness query.
 */
const assertEmailVerificationCandidate = async (email: string): Promise<EmailVerificationCandidate> => {
  type CandidateRow = {
    id: string;
    role: UserRole;
    hasCredentialAccount: boolean;
    adminId: string | null;
    hasActiveSubscription: boolean;
    hasWebsite: boolean;
  };

  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT
      u.id,
      u.role::text AS role,
      EXISTS (
        SELECT 1 FROM "account" a
        WHERE a."userId" = u.id AND a."providerId" = 'credential'
      ) AS "hasCredentialAccount",
      ap.id AS "adminId",
      CASE WHEN ap.id IS NULL THEN FALSE ELSE EXISTS (
        SELECT 1 FROM "Subscription" s
        WHERE s."adminId" = ap.id AND s.status::text = ${SubscriptionStatus.ACTIVE}
      ) END AS "hasActiveSubscription",
      CASE WHEN ap.id IS NULL THEN FALSE ELSE EXISTS (
        SELECT 1 FROM "business_website" bw WHERE bw."adminId" = ap.id
      ) END AS "hasWebsite"
    FROM "user" u
    LEFT JOIN "AdminProfile" ap ON ap."userId" = u.id
    WHERE LOWER(u.email) = LOWER(${email.trim()})
    LIMIT 1
  `;

  const candidate = rows[0];
  if (!candidate) throw new AppError(status.NOT_FOUND, "User not found.");
  if (!candidate.hasCredentialAccount) {
    throw new AppError(status.BAD_REQUEST, "Email verification is not allowed for social login accounts.");
  }

  if (candidate.role === UserRole.ADMIN) {
    if (!candidate.adminId) throw provisioningError("ADMIN_PROFILE_MISSING");
    if (!candidate.hasActiveSubscription) throw provisioningError("SUBSCRIPTION_PROVISIONING_INCOMPLETE");
    if (!candidate.hasWebsite) throw provisioningError("WEBSITE_PROVISIONING_INCOMPLETE");
  }

  return {
    id: candidate.id,
    role: candidate.role,
    hasCredentialAccount: candidate.hasCredentialAccount,
  };
};

/**
 * Activation gate used before consuming the email OTP. New registrations must
 * have the full transaction-created tenant graph and an ACTIVE trial/subscription.
 */
const assertAdminReadyForActivation = async (userId: string) => {
  type ActivationReadinessRow = {
    adminId: string;
    onboardingCompletedAt: Date | null;
    hasActiveSubscription: boolean;
    hasWebsite: boolean;
  };

  // One SQL round trip verifies the three registration invariants. Prisma
  // relation selects can fan out into separate statements depending on the
  // relation-load strategy; EXISTS keeps this hot OTP path deterministic.
  const rows = await prisma.$queryRaw<ActivationReadinessRow[]>`
    SELECT
      ap.id AS "adminId",
      ap."onboardingCompletedAt",
      EXISTS (
        SELECT 1 FROM "Subscription" s
        WHERE s."adminId" = ap.id AND s.status::text = ${SubscriptionStatus.ACTIVE}
      ) AS "hasActiveSubscription",
      EXISTS (
        SELECT 1 FROM "business_website" bw WHERE bw."adminId" = ap.id
      ) AS "hasWebsite"
    FROM "AdminProfile" ap
    WHERE ap."userId" = ${userId}
    LIMIT 1
  `;

  const admin = rows[0];
  if (!admin) throw provisioningError("ADMIN_PROFILE_MISSING");
  if (!admin.hasActiveSubscription) {
    throw provisioningError("SUBSCRIPTION_PROVISIONING_INCOMPLETE");
  }
  if (!admin.hasWebsite) {
    throw provisioningError("WEBSITE_PROVISIONING_INCOMPLETE");
  }

  return {
    adminId: admin.adminId,
    isOnboardingComplete: admin.onboardingCompletedAt != null,
  };
};

/**
 * Idempotently repairs legacy ACTIVE+verified ADMIN accounts only.
 *
 * The transaction-scoped advisory lock serializes concurrent release jobs and
 * manual retries for the same user. The function never changes verification,
 * status or role and never rewrites existing subscription history.
 */
const repairActiveAdminProvisioning = async (
  userId: string,
): Promise<AdminProvisioningRepairResult> => {
  // Resolve platform config before opening the transaction so a config lookup
  // never holds the provisioning advisory lock / transaction connection.
  const { defaultTrialDays } = await getPlatformConfig();
  let createdWebsiteSubdomain: string | null = null;

  const result = await prisma.$transaction(async (tx) => {
    await acquireExtendedTextTransactionAdvisoryLock(tx, repairLockKey(userId));

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        emailVerified: true,
        admin: {
          select: {
            id: true,
            businessName: true,
            businessWebsite: { select: { id: true } },
            subscription: { select: { id: true }, take: 1 },
          },
        },
      },
    });

    const eligible = Boolean(
      user &&
        user.role === UserRole.ADMIN &&
        user.status === AccountStatus.ACTIVE &&
        user.emailVerified,
    );

    if (!user || !eligible) {
      return {
        userId,
        eligible: false,
        healthy: true,
        adminId: user?.admin?.id ?? null,
        issues: [],
        repaired: false,
        actions: [],
      } satisfies AdminProvisioningRepairResult;
    }

    const actions: AdminProvisioningRepairResult["actions"] = [];
    let admin = user.admin;

    if (!admin) {
      admin = await tx.adminProfile.create({
        data: {
          userId: user.id,
          businessName: safeBusinessName(user.name, user.email),
          businessEmail: user.email,
        },
        select: {
          id: true,
          businessName: true,
          businessWebsite: { select: { id: true } },
          subscription: { select: { id: true }, take: 1 },
        },
      });
      actions.push("ADMIN_PROFILE_CREATED");
    }

    if (admin.subscription.length === 0) {
      await subscriptionService.createTrialSubscription(admin.id, {
        db: tx,
        trialDays: defaultTrialDays,
      });
      actions.push("TRIAL_SUBSCRIPTION_CREATED");
    }

    if (!admin.businessWebsite) {
      const provisioned = await WebsiteProvisioningService.provisionDefaultWebsiteForAdminTx(tx, {
        adminId: admin.id,
        businessName: admin.businessName || safeBusinessName(user.name, user.email),
        createdByUserId: user.id,
        initialRevisionReason: "Phase 2 provisioning integrity repair",
      });
      if (provisioned.created) {
        createdWebsiteSubdomain = provisioned.website.subdomain;
        actions.push("BUSINESS_WEBSITE_CREATED");
      }
    }

    return {
      userId,
      eligible: true,
      healthy: true,
      adminId: admin.id,
      issues: [],
      repaired: actions.length > 0,
      actions,
    } satisfies AdminProvisioningRepairResult;
  }, PROVISIONING_TRANSACTION_OPTIONS);

  if (createdWebsiteSubdomain) {
    await WebsiteHostResolverService.invalidateSubdomains([createdWebsiteSubdomain]).catch((error) => {
      logger.warn("Provisioning repair committed but website host cache invalidation failed", {
        userId,
        subdomain: createdWebsiteSubdomain,
        error,
      });
    });
  }

  return result;
};

export const AccountIntegrityService = {
  inspectActiveAdminProvisioning,
  assertAdminReadyForActivation,
  repairActiveAdminProvisioning,
};
