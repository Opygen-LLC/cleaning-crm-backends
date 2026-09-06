import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { Prisma } from "../../generated/prisma/client";
import { ServiceStatus } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import redis from "../../config/redis";
import logger from "../../lib/logger";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { bumpCacheResourceVersions, CacheResource } from "../../lib/cache/resourceCacheVersion";
import { adminService } from "./admin.service";
import { assertStepOrder, completeStepTx, lockOnboardingOwnerTx, normalizeCompletedSetupSteps } from "./onboardingProgress";
import { onboardingStepSaveSchema, type OnboardingStepSavePayload } from "./onboardingSave.contract";
import { WebsiteService } from "../Website/website.service";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { WebsiteBookingProvisioningService } from "../Website/websiteBookingProvisioning.service";
import { SubdomainService } from "../Website/subdomain.service";
import { WEBSITE_STATUS, statusAfterDraftMutation } from "../Website/websiteLifecycle";
import { fingerprint, lockServiceCatalogTx, readOnboardingCatalogTx } from "../ServiceCatalog/serviceCatalogConcurrency";
import { syncServiceCatalogSelectionTx, invalidateServiceCatalogReadModels } from "../ServiceCatalog/serviceCatalog.service";

type Step = OnboardingStepSavePayload["step"];
const transactionOptions = { maxWait: 15_000, timeout: 35_000 };

const readSaveResultTx = async (
  tx: Prisma.TransactionClient, userId: string, adminId: string, step: Step, replayed: boolean,
) => {
  const bootstrap = await adminService.getOnboardingBootstrap(adminId, tx);
  const onboarding = await adminService.getOnboardingStatus(userId, tx);
  const catalog = step === "services" ? await readOnboardingCatalogTx(tx, adminId) : null;
  const bookingSetup = step === "services" ? await WebsiteBookingProvisioningService.getSetupByAdminId(adminId, tx) : null;
  return {
    schemaVersion: 2 as const, userId, adminId, step, replayed,
    draftRevisionNumber: bootstrap.website.draftRevisionNumber,
    // Every persisted profile/branding/address field is returned here. Progress
    // and the revision were read under the very same write transaction/locks.
    bootstrap, onboarding, catalog, bookingSetup,
    nextStep: onboarding.resumeStep,
  };
};
export type OnboardingStepSaveResult = Awaited<ReturnType<typeof readSaveResultTx>>;

const getServicesContext = async (userId: string) => prisma.$transaction(async tx => {
  const owner = await lockOnboardingOwnerTx(tx, userId);
  await acquireExtendedTextTransactionAdvisoryLock(tx, `website-booking-provision:${owner.id}`);
  await lockServiceCatalogTx(tx, owner.id);
  return readSaveResultTx(tx, userId, owner.id, "services", false);
}, transactionOptions);

const saveStep = async (userId: string, input: OnboardingStepSavePayload): Promise<OnboardingStepSaveResult> => {
  // Validate internal callers too, rather than trusting only Express middleware.
  const payload = onboardingStepSaveSchema.parse(input);
  const reason = `Onboarding v2:${payload.step}:${fingerprint(payload)}`;
  const committed = await prisma.$transaction(async tx => {
    const owner = await lockOnboardingOwnerTx(tx, userId);
    if (payload.websiteId !== owner.websiteId) throw new AppError(status.CONFLICT, "The active business changed. Reload this form before saving.", { code: "ONBOARDING_WEBSITE_CHANGED", retryable: false });
    if (payload.step === "services") {
      await acquireExtendedTextTransactionAdvisoryLock(tx, `website-booking-provision:${owner.id}`);
      await lockServiceCatalogTx(tx, owner.id);
    }
    const website = await tx.businessWebsite.findUniqueOrThrow({ where: { id: owner.websiteId }, select: { status: true } });
    if (website.status === WEBSITE_STATUS.SUSPENDED) throw new AppError(status.CONFLICT, "Suspended websites cannot be edited", { code: "WEBSITE_SUSPENDED", retryable: false });

    // The existing immutable revision is the durable request receipt. A retry
    // after a lost response never re-applies an old change set over newer edits.
    // Include expected versions in its hash so a deliberate later save is new.
    const receipt = await tx.websiteRevision.findFirst({
      where: { websiteId: owner.websiteId, reason }, select: { id: true },
    });
    if (receipt) return { result: await readSaveResultTx(tx, userId, owner.id, payload.step, true), rename: null };

    assertStepOrder(payload.step, normalizeCompletedSetupSteps(owner.onboardingCompletedSteps, owner.onboardingCompletedAt));
    const revision = await WebsiteService.assertExpectedRevisionTx(tx, owner.websiteId, payload.expectedRevisionNumber);
    await WebsiteService.ensurePublishedSnapshotBeforeDraftMutationTx(tx, owner.websiteId);
    let rename: Awaited<ReturnType<typeof SubdomainService.renameForWebsiteTx>> | null = null;

    if (payload.step === "business_profile") {
      const before = await adminService.getOnboardingBootstrap(owner.id, tx);
      if (before.profileVersion !== payload.expectedProfileVersion) throw new AppError(status.CONFLICT, "Business profile changed in another session. Reload before saving.", {
        code: "ONBOARDING_PROFILE_CONFLICT", retryable: false,
        fieldErrors: { profile: "Your edits have not been saved. Reload the latest profile and review them." },
      });
      const { postcode, zipcode, businessHours, ...scalars } = payload.profile;
      const hours = businessHours && businessHours.timezone === undefined && before.profile.businessHours?.timezone
        ? { ...businessHours, timezone: before.profile.businessHours.timezone } : businessHours;
      await tx.adminProfile.update({ where: { id: owner.id }, data: {
        ...scalars,
        ...(postcode !== undefined || zipcode !== undefined ? { zipcode: postcode !== undefined ? postcode : zipcode } : {}),
        ...(hours !== undefined ? { businessHours: hours === null ? Prisma.DbNull : hours as Prisma.InputJsonValue } : {}),
      } });
    } else if (payload.step === "branding") {
      await WebsiteService.saveOnboardingBrandingTx(tx, owner.id, owner.websiteId, payload.branding);
    } else if (payload.step === "website_address") {
      rename = await SubdomainService.renameForWebsiteTx(tx, owner.websiteId, payload.subdomain, false);
    } else {
      const catalog = await readOnboardingCatalogTx(tx, owner.id);
      if (catalog.version !== payload.catalogVersion) throw new AppError(status.CONFLICT, "Services changed in another session. Reload the catalog before saving.", {
        code: "ONBOARDING_CATALOG_CONFLICT", retryable: false,
        fieldErrors: { services: "Your changes were not applied. Reload and review the current services." },
      });
      await syncServiceCatalogSelectionTx(tx, owner.id,
        payload.services.map(service => ({ ...service, status: ServiceStatus.ACTIVE })),
        { deactivateServiceCatalogIds: payload.deactivateServiceCatalogIds, requireIdentityForExisting: true },
      );
      const activeCount = await tx.serviceCatalog.count({ where: { adminId: owner.id, status: ServiceStatus.ACTIVE } });
      if (!activeCount) throw new AppError(status.CONFLICT, "Keep at least one active service.", { code: "ONBOARDING_SERVICE_REQUIRED", retryable: false, fieldErrors: { services: "Select at least one service." } });
      if (payload.booking.enabled) {
        const bookableCount = await tx.serviceCatalog.count({ where: { adminId: owner.id, status: ServiceStatus.ACTIVE, onlineBookingEnabled: true } });
        if (!bookableCount) throw new AppError(status.CONFLICT, "Enable online booking for at least one service.", { code: "NO_BOOKABLE_SERVICES", retryable: false, fieldErrors: { services: "Select a bookable service or turn booking off." } });
      }
      await WebsiteBookingProvisioningService.configureForAdminTx(tx, owner.id, payload.booking);
    }
    await tx.businessWebsite.update({ where: { id: owner.websiteId }, data: { status: statusAfterDraftMutation(website.status) } });
    await completeStepTx(tx, owner, payload.step);
    await WebsiteService.createRevisionSnapshotTx(tx, owner.websiteId, userId, reason, revision);
    return { result: await readSaveResultTx(tx, userId, owner.id, payload.step, false), rename };
  }, transactionOptions);

  const { result, rename } = committed;
  // Nothing below can undo a committed save or represent a warming attempt as
  // publication readiness. Retrying returns the receipt, not a second write.
  const deliveries: Promise<unknown>[] = [
    redis.del(`admin:profile:${userId}`),
    WebsiteProjectionCacheService.invalidateStudioAdmin(result.adminId),
    bumpCacheResourceVersions(result.adminId, [CacheResource.onboarding, CacheResource.profile, CacheResource.website, CacheResource.dashboard]),
  ];
  if (payload.step === "services") deliveries.push(invalidateServiceCatalogReadModels(result.adminId));
  if (payload.step === "business_profile") deliveries.push(WebsiteProjectionCacheService.invalidateAdminWebsite(result.adminId));
  if (rename) deliveries.push(SubdomainService.deliverRename(result.bootstrap.website.id, rename));
  const outcomes = await Promise.allSettled(deliveries);
  if (outcomes.some(outcome => outcome.status === "rejected")) logger.warn("onboarding_save_cache_delivery_failed", {
    adminId: result.adminId, step: result.step, draftRevisionNumber: result.draftRevisionNumber,
  });
  return result;
};

export const OnboardingSaveService = { saveStep, getServicesContext };
