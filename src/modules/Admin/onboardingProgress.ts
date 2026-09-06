import status from "http-status";
import AppError from "../../errorHelper/AppError";
import type { Prisma } from "../../generated/prisma/client";
import { acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { ONBOARDING_STEPS } from "./admin.constant";
import type { OnboardingStepKey, LegacyOnboardingStepKey } from "./admin.interface";

export const REQUIRED_SETUP_KEYS = ONBOARDING_STEPS.map(step => step.key);
export const canonicalOnboardingStep = (step: OnboardingStepKey | LegacyOnboardingStepKey): OnboardingStepKey =>
  step === "template" ? "review_launch" : step;

export const normalizeCompletedSetupSteps = (steps: string[], completedAt: Date | null): Set<OnboardingStepKey> => {
  if (completedAt) return new Set(REQUIRED_SETUP_KEYS);
  const allowed = new Set<string>(REQUIRED_SETUP_KEYS);
  return new Set(steps.map(step => step === "template" ? "review_launch" : step)
    .filter((step): step is OnboardingStepKey => allowed.has(step)));
};

export const assertStepOrder = (step: OnboardingStepKey, completed: Set<OnboardingStepKey>) => {
  const index = REQUIRED_SETUP_KEYS.indexOf(step);
  if (index < 0) throw new AppError(status.BAD_REQUEST, "Unknown onboarding step", { code: "INVALID_ONBOARDING_STEP", retryable: false });
  const missing = REQUIRED_SETUP_KEYS.slice(0, index).find(key => !completed.has(key));
  if (missing) throw new AppError(status.CONFLICT, "Complete the previous setup step first.", {
    code: "ONBOARDING_STEP_OUT_OF_ORDER", retryable: false,
    fieldErrors: { [missing]: "Complete this step first" },
  });
};

/** Re-read only AFTER acquiring the same lock as launch and editor writes. */
export const lockOnboardingOwnerTx = async (tx: Prisma.TransactionClient, userId: string) => {
  const identity = await tx.adminProfile.findUnique({
    where: { userId }, select: { id: true, businessWebsite: { select: { id: true } } },
  });
  if (!identity) throw new AppError(status.NOT_FOUND, "Admin profile not found", { code: "ADMIN_PROFILE_NOT_FOUND", retryable: false });
  if (!identity.businessWebsite) throw new AppError(status.CONFLICT, "Website provisioning is not complete yet.", { code: "WEBSITE_PROVISIONING_INCOMPLETE", retryable: true });
  await acquireTextTransactionAdvisoryLock(tx, identity.businessWebsite.id);
  // Serialize profile edits that don't use the website editor as well. The
  // website lock always precedes the owner row lock to avoid inverted ordering.
  await tx.$queryRaw`SELECT id FROM "AdminProfile" WHERE id = ${identity.id} FOR UPDATE`;
  const owner = await tx.adminProfile.findUniqueOrThrow({
    where: { id: identity.id },
    select: { id: true, onboardingCompletedAt: true, onboardingCompletedSteps: true },
  });
  return { ...owner, websiteId: identity.businessWebsite.id };
};

/** Caller holds the website lock; use a normalized set, never PostgreSQL push. */
export const completeStepTx = async (
  tx: Prisma.TransactionClient,
  owner: { id: string; onboardingCompletedAt: Date | null; onboardingCompletedSteps: string[] },
  step: OnboardingStepKey,
) => {
  const completed = normalizeCompletedSetupSteps(owner.onboardingCompletedSteps, owner.onboardingCompletedAt);
  assertStepOrder(step, completed);
  completed.add(step);
  const next = REQUIRED_SETUP_KEYS.filter(key => completed.has(key));
  if (JSON.stringify(next) !== JSON.stringify(owner.onboardingCompletedSteps)) {
    await tx.adminProfile.update({ where: { id: owner.id }, data: { onboardingCompletedSteps: next } });
  }
};
