import { randomUUID } from "node:crypto";
import status from "http-status";
import { hashPassword } from "better-auth/crypto";
import {
  AccountStatus,
  Prisma,
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
import { WebsiteHostResolverService } from "../Website/websiteHostResolver.service";
import { WebsiteProvisioningService } from "../Website/websiteProvisioning.service";

export interface ProvisionRegisteredAdminInput {
  name: string;
  email: string;
  password: string;
  businessName: string;
  trialDays: number;
}

const registrationEmailUnavailable = () =>
  new AppError(
    status.CONFLICT,
    "Unable to create an account with this email. If you already have an account, sign in or reset your password.",
    {
      code: "REGISTRATION_EMAIL_UNAVAILABLE",
      retryable: false,
      fieldErrors: {
        email: "This email cannot be used for a new account. Sign in or reset your password if it is yours.",
      },
    },
  );

const isUserEmailUniqueConstraintError = (error: unknown) => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
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
 *     -> AdminProfile
 *     -> advisory-locked unique subdomain
 *     -> BusinessWebsite + default pages + revision #1
 *     -> trial subscription
 *     -> verification-email outbox event
 *
 * If any database write fails, PostgreSQL rolls back the complete registration.
 * There is no compensating-delete window and no auth-only orphan to recover.
 */
const provisionRegisteredAdmin = async (input: ProvisionRegisteredAdminInput) => {
  const email = input.email.trim().toLowerCase();

  // Fast duplicate check avoids paying the scrypt cost for the common existing
  // email case. The unique index remains the final authority for concurrent
  // requests and is mapped to the same safe error below.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) throw registrationEmailUnavailable();

  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();
  const credentialAccountId = randomUUID();

  const result = await runProvisioningTransaction({
    ...input,
    email,
    passwordHash,
    userId,
    credentialAccountId,
  }).catch((error: unknown) => {
    // A concurrent signup can pass the pre-check and lose the unique-email
    // race inside the transaction. Fail closed without leaking account state.
    if (isUserEmailUniqueConstraintError(error)) throw registrationEmailUnavailable();
    throw error;
  });

  // Cache invalidation is deliberately post-commit and non-critical. Returning
  // a 500 after the DB committed would make a successful registration look
  // retryable and the retry would then collide with the newly created email.
  void WebsiteHostResolverService.invalidateSubdomains([result.website.subdomain]).catch((error) => {
    logger.warn("Registration committed but website host cache invalidation failed", {
      userId: result.user.id,
      websiteId: result.website.id,
      subdomain: result.website.subdomain,
      error,
    });
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

const runProvisioningTransaction = async (input: ProvisionRegisteredAdminInput & {
  email: string;
  passwordHash: string;
  userId: string;
  credentialAccountId: string;
}) => prisma.$transaction(
  async (tx: Prisma.TransactionClient) => {
    const user = await tx.user.create({
      data: {
        id: input.userId,
        name: input.name.trim(),
        email: input.email,
        emailVerified: false,
        role: UserRole.ADMIN,
        status: AccountStatus.PENDING,
        needPasswordChange: false,
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

    // Better Auth stores email/password credentials in Account with
    // providerId=credential and accountId=user.id. Using Better Auth's own
    // hashPassword keeps login/change-password compatibility intact.
    await tx.account.create({
      data: {
        id: input.credentialAccountId,
        accountId: input.userId,
        providerId: "credential",
        userId: input.userId,
        password: input.passwordHash,
      },
    });

    const admin = await adminService.createAdmin(
      { userId: input.userId, businessName: input.businessName.trim() },
      tx,
    );

    const { website } = await WebsiteProvisioningService.provisionDefaultWebsiteForAdminTx(
      tx,
      {
        adminId: admin.id,
        businessName: input.businessName.trim(),
        createdByUserId: input.userId,
      },
    );

    const subscription = await subscriptionService.createTrialSubscription(admin.id, {
      db: tx,
      trialDays: input.trialDays,
    });

    // The durable outbox row commits with the account. Registration returns as
    // soon as PostgreSQL commits; the email worker generates/sends the Better
    // Auth OTP independently and retries SMTP failures with backoff.
    await AuthEmailOutbox.enqueueEmailVerificationTx(
      tx,
      { userId: input.userId, email: input.email },
      { dedupeKey: `registration-email-verification:${input.userId}` },
    );

    return { user, admin, website, subscription };
  },
  PROVISIONING_TRANSACTION_OPTIONS,
);

export const AccountProvisioningService = {
  provisionRegisteredAdmin,
};
