import { randomUUID } from "node:crypto";
import status from "http-status";
import { hashPassword } from "better-auth/crypto";
import {
  AccountStatus,
  Prisma,
  SubscriptionName,
  SubscriptionPlanInterval,
  UserRole,
} from "../../generated/prisma/client";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import AppError from "../../errorHelper/AppError";
import logger from "../../lib/logger";
import { AuthEmailOutbox } from "../../lib/outbox/authEmailOutbox";
import { prisma } from "../../lib/prisma/prisma";
import { PROVISIONING_TRANSACTION_OPTIONS } from "../../lib/prisma/transactionPolicy";
import { adminService } from "../Admin/admin.service";
import { subscriptionService } from "../Subscription/subscription.service";
import { seedRecommendedCleaningServicesTx } from "../ServiceCatalog/recommendedCleaningServices";
import { WebsiteHostResolverService } from "../Website/websiteHostResolver.service";
import { WebsiteProvisioningService } from "../Website/websiteProvisioning.service";

export interface ProvisionRegisteredAdminInput {
  name: string;
  email: string;
  password: string;
  businessName: string;
  /** ISO-3166-1 alpha-2 country chosen in registration Step 1. */
  country: string;
  trialDays: number;
  requireEmailVerification?: boolean;
  /** Optional fields collected in the 2-step registration wizard */
  mobileNumber?: string;
  businessType?: "residential" | "commercial" | "both";
  licenseNumber?: string;
}

const registrationEmailUnavailable = () =>
  new AppError(
    status.CONFLICT,
    "Unable to create an account with this email. If you already have an account, sign in or reset your password.",
    {
      code: "REGISTRATION_EMAIL_UNAVAILABLE",
      retryable: false,
      fieldErrors: {
        email:
          "This email cannot be used for a new account. Sign in or reset your password if it is yours.",
      },
    },
  );

const isUserEmailUniqueConstraintError = (error: unknown) => {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const target = Array.isArray(meta.target)
    ? meta.target.map(String).join(",").toLowerCase()
    : String(meta.target ?? "").toLowerCase();
  const modelName = String(meta.modelName ?? "").toLowerCase();
  return target.includes("email") && (!modelName || modelName === "user");
};

/**
 * Canonical registration transaction.
 *
 * Password hashing intentionally happens before the transaction opens so the
 * CPU-expensive scrypt work never holds PostgreSQL locks/connections. Every
 * persistent registration record is then created in one bounded transaction:
 *
 *   User + credential Account
 *     -> AdminProfile (with optional mobileNumber / businessType / licenseNumber)
 *     -> advisory-locked unique subdomain
 *     -> BusinessWebsite + default pages + revision #1
 *     -> recommended cleaning-service starter catalogue (inactive/unpriced)
 *     -> trial subscription
 *     -> verification-email outbox event
 *
 * If any database write fails, PostgreSQL rolls back the complete registration.
 * There is no compensating-delete window and no auth-only orphan to recover.
 */
const provisionRegisteredAdmin = async (
  input: ProvisionRegisteredAdminInput,
) => {
  const email = input.email.trim().toLowerCase();

  // User.email has a database unique constraint and remains the sole authority.
  // Avoid SELECT -> INSERT here: it adds a round trip and still cannot prevent
  // a concurrent-registration race. P2002 below maps duplicates to the same
  // enumeration-safe error. Password hashing remains outside the transaction.
  // Resolve CPU work and immutable trial-plan metadata concurrently before
  // opening the transaction. This shortens connection/lock hold time on the
  // registration hot path without weakening atomicity of tenant writes.
  const [passwordHash, trialPlan] = await Promise.all([
    hashPassword(input.password),
    prisma.plan.findFirst({
      where: {
        subscriptionPlan: { name: SubscriptionName.GROWTH },
        interval: SubscriptionPlanInterval.MONTHLY,
      },
      select: { id: true, subscriptionPlanId: true },
    }),
  ]);
  if (!trialPlan) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Default trial plan is not configured", {
      code: "DEFAULT_TRIAL_PLAN_NOT_CONFIGURED",
      retryable: false,
    });
  }
  const userId = randomUUID();
  const credentialAccountId = randomUUID();

  const result = await runProvisioningTransaction({
    ...input,
    email,
    passwordHash,
    userId,
    credentialAccountId,
    trialPlan,
  }).catch((error: unknown) => {
    // A concurrent signup can pass the pre-check and lose the unique-email
    // race inside the transaction. Fail closed without leaking account state.
    if (isUserEmailUniqueConstraintError(error))
      throw registrationEmailUnavailable();
    throw error;
  });

  // Cache invalidation is deliberately post-commit and non-critical. Returning
  // a 500 after the DB committed would make a successful registration look
  // retryable and the retry would then collide with the newly created email.
  void WebsiteHostResolverService.invalidateSubdomains([
    result.website.subdomain,
  ]).catch((error) => {
    logger.warn(
      "Registration committed but website host cache invalidation failed",
      {
        userId: result.user.id,
        websiteId: result.website.id,
        subdomain: result.website.subdomain,
        error,
      },
    );
  });

  return {
    user: result.user,
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

const runProvisioningTransaction = async (
  input: ProvisionRegisteredAdminInput & {
    email: string;
    passwordHash: string;
    userId: string;
    credentialAccountId: string;
    trialPlan: { id: string; subscriptionPlanId: string };
  },
) =>
  prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const user = await tx.user.create({
        data: {
          id: input.userId,
          name: input.name.trim(),
          email: input.email,
          emailVerified: input.requireEmailVerification === false,
          role: UserRole.ADMIN,
          status: input.requireEmailVerification === false ? AccountStatus.ACTIVE : AccountStatus.PENDING,
          needPasswordChange: false,
          accounts: {
            create: {
              id: input.credentialAccountId,
              accountId: input.userId,
              providerId: "credential",
              password: input.passwordHash,
            },
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          image: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });


      // Pass optional wizard fields into the AdminProfile at creation time so
      // they are immediately available without a separate PATCH call.
      const admin = await adminService.createAdmin(
        {
          userId: input.userId,
          businessName: input.businessName.trim(),
          country: input.country,
          mobileNumber: input.mobileNumber,
          businessType: input.businessType,
          licenseNumber: input.licenseNumber,
        },
        tx,
      );

      const { website } =
        await WebsiteProvisioningService.provisionDefaultWebsiteForAdminTx(
          tx,
          {
            adminId: admin.id,
            businessName: input.businessName.trim(),
            createdByUserId: input.userId,
            skipExistingCheck: true,
          },
        );

      // Seed a safe starter catalogue after website provisioning so the
      // transaction follows the documented advisory-lock order. Presets start
      // inactive with no fabricated price and the seeder is idempotent, so a
      // retry/recovery path cannot duplicate them.
      await seedRecommendedCleaningServicesTx(tx, admin.id);

      const subscription =
        await subscriptionService.createTrialSubscription(admin.id, {
          db: tx,
          trialDays: input.trialDays,
          skipExistingCheck: true,
          preloadedPlan: input.trialPlan,
        });

      // The durable outbox row commits with the account. Registration returns
      // as soon as PostgreSQL commits; the email worker generates/sends the
      // Better Auth OTP independently and retries SMTP failures with backoff.
      if (input.requireEmailVerification !== false) {
        await AuthEmailOutbox.enqueueEmailVerificationTx(
          tx,
          { userId: input.userId, email: input.email },
          { dedupeKey: `registration-email-verification:${input.userId}` },
        );
      }

      return { user, admin, website, subscription };
    },
    PROVISIONING_TRANSACTION_OPTIONS,
  );

export const AccountProvisioningService = {
  provisionRegisteredAdmin,
};
