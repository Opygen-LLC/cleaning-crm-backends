import { createHash } from "node:crypto";
import { startOfMonth } from "date-fns";
import status from "http-status";
import { prisma } from "../../lib/prisma/prisma";
import logger from "../../lib/logger";
import AppError from "../../errorHelper/AppError";
import { normalizeOptionalE164Phone, requireE164Phone } from "../../lib/validation/phone";
import { countryEnumToIso, resolveCountryEnum } from "../../lib/constants/countryIsoMap";
import { getCountryRegionalDefaults } from "../../lib/constants/countryRegionalDefaults";
import {
  GETTING_STARTED_STEPS,
  ONBOARDING_STEPS,
  SKIPPABLE_ONBOARDING_STEPS,
} from "./admin.constant";
import redis from "../../config/redis";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { WEBSITE_STATUS } from "../Website/websiteLifecycle";
import { WebsiteService } from "../Website/website.service";
import { getCanonicalWebsiteOrigin } from "../Website/websiteCanonicalHost";
import { WebsiteBookingProvisioningService } from "../Website/websiteBookingProvisioning.service";
import { invalidateServiceCatalogReadModels, syncServiceCatalogSelectionTx } from "../ServiceCatalog/serviceCatalog.service";
import { acquireExtendedTextTransactionAdvisoryLock, acquireTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { RELEASE_VERSION } from "../../config/ENV";
import { ErrorMonitor } from "../../lib/monitoring/errorMonitor";
import { recordClientReliabilitySignals, recordProductReliabilitySignal } from "../../lib/monitoring/productReliabilityMetrics";
import { AccountStatus, ServiceStatus, SubscriptionStatus } from "../../generated/prisma/enums";
import { Prisma } from "../../generated/prisma/client";
import { fingerprint, lockServiceCatalogTx } from "../ServiceCatalog/serviceCatalogConcurrency";
import { REQUIRED_SETUP_KEYS, normalizeCompletedSetupSteps, lockOnboardingOwnerTx, completeStepTx, canonicalOnboardingStep } from "./onboardingProgress";
import { businessHoursSchema, normalizeBusinessHours, type BusinessHours } from "./businessHours";
import { onboardingProfile } from "./onboardingProfile";
import { bumpCacheResourceVersions, CacheResource } from "../../lib/cache/resourceCacheVersion";
import { invalidateAdminTimezoneCache } from "../Lead/followUpCache";
import type {
  GettingStartedStepKey,
  LegacyOnboardingStepKey,
  LegacySkippableOnboardingStepKey,
  OnboardingStepKey,
  OnboardingStepStatus,
  OnboardingClientErrorPayload,
  UpdateAdminPayload,
  UpdateWorkLocationPayload,
  SaveOnboardingServicesPayload,
} from "./admin.interface";

export interface AdminUsageResponse {
  /** Real-time counts */
  staffCount: number;
  clientCount: number;
  bookingCountThisMonth: number;

  /**
   * Plan caps after applying any per-admin add-ons.
   * null means the plan is unlimited for that resource.
   */
  caps: {
    staff: number | null;
    clients: number | null;
    bookingsPerMonth: number | null;
  };

  /** Convenience: pct of each cap that is consumed (0-100, null if unlimited) */
  pct: {
    staff: number | null;
    clients: number | null;
    bookingsPerMonth: number | null;
  };

  /** True when any capped resource is >= 90% consumed */
  anyNearLimit: boolean;

  /** Snapshot ids for cache-busting on the client */
  subscriptionId: string | null;
  planId: string | null;
}

// ── Shared helper: load the AdminProfile.id for a given auth userId ─────────
const findAdminIdOrThrow = async (userId: string): Promise<string> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  return admin.id;
};

const assertTenantWorkLocationCountry = (
  tenantCountryIso: string | undefined,
  submittedCountryIso: string | undefined,
) => {
  if (!tenantCountryIso) {
    throw new AppError(status.CONFLICT, "Set the business country before saving service areas.", {
      code: "BUSINESS_COUNTRY_REQUIRED",
      retryable: false,
      fieldErrors: { country: "Set the business country first." },
    });
  }
  if (submittedCountryIso && submittedCountryIso.toUpperCase() !== tenantCountryIso) {
    throw new AppError(status.UNPROCESSABLE_ENTITY, "Service areas must use the registered business country.", {
      code: "WORK_LOCATION_COUNTRY_MISMATCH",
      retryable: false,
      fieldErrors: { workLocations: "Choose cities from the registered business country." },
    });
  }
};

// ── Get admin profile (identity + business + work locations) ───────────────
const getAdmin = async (userId: string) => {
  const cacheKey = `admin:profile:${userId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      // fall through if corrupt
    }
  }

  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          image: true,
        },
      },
      workLocations: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  const { user, workLocations, id: _adminProfileId, userId: _userId, ...profileFields } = admin;

  const countryIso = countryEnumToIso(profileFields.country);
  const result = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.image ?? undefined,
    ...profileFields,
    businessHours: normalizeBusinessHours(profileFields.businessHours),
    postcode: profileFields.zipcode ?? null,
    countryIso,
    regionalDefaults: countryIso ? getCountryRegionalDefaults(countryIso) ?? null : null,
    workLocations,
  };

  await redis.setex(cacheKey, 300, JSON.stringify(result)).catch(() => {});

  return result;
};

// ── Update admin profile (scalar fields + optional bulk work-location set) ──
const updateAdmin = async (userId: string, payload: UpdateAdminPayload) => {
  const adminId = await findAdminIdOrThrow(userId);

  const { workLocations, country, postcode, zipcode, businessLogoAssetId: _businessLogoAssetId, ...scalarFields } = payload;

  const data: Record<string, unknown> = {
    ...scalarFields,
    ...(scalarFields.businessHours === null ? { businessHours: Prisma.DbNull } : {}),
    ...(scalarFields.mobileNumber !== undefined
      ? { mobileNumber: normalizeOptionalE164Phone(scalarFields.mobileNumber, "mobileNumber") ?? null }
      : {}),
    ...(postcode !== undefined || zipcode !== undefined
      ? { zipcode: postcode !== undefined ? postcode : zipcode }
      : {}),
  };

  // Country is tenant identity. Registration always sets it before OTP; a
  // legacy profile with no country may claim one exactly once. Resolve the
  // requested country before entering the transaction, then use an atomic
  // updateMany claim so two concurrent legacy requests cannot overwrite each
  // other. Same-country PATCHes remain idempotent for rolling clients.
  let requestedCountry: ReturnType<typeof resolveCountryEnum> | undefined;
  if (country !== undefined) {
    if (country === null) {
      throw new AppError(status.CONFLICT, "Business country is locked after registration.", {
        code: "BUSINESS_COUNTRY_LOCKED",
        retryable: false,
        fieldErrors: { country: "Business country cannot be cleared after registration." },
      });
    }
    requestedCountry = resolveCountryEnum(country);
    if (!requestedCountry) {
      throw new AppError(status.BAD_REQUEST, `Unrecognised country: "${country}"`, {
        code: "BUSINESS_COUNTRY_INVALID",
        retryable: false,
        fieldErrors: { country: "Select a supported business country." },
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    if (requestedCountry) {
      const claimed = await tx.adminProfile.updateMany({
        where: { id: adminId, country: null },
        data: { country: requestedCountry },
      });

      if (claimed.count === 0) {
        const current = await tx.adminProfile.findUnique({
          where: { id: adminId },
          select: { country: true },
        });
        if (!current) throw new AppError(status.NOT_FOUND, "Admin profile not found");
        if (current.country !== requestedCountry) {
          throw new AppError(status.CONFLICT, "Business country is locked after registration.", {
            code: "BUSINESS_COUNTRY_LOCKED",
            retryable: false,
            fieldErrors: { country: "Contact support if the registered business country must be corrected." },
          });
        }
      }
    }

    if (Object.keys(data).length > 0) {
      await tx.adminProfile.update({ where: { id: adminId }, data });
    }

    // The bulk `workLocations` field on the profile payload is a full
    // replace of the admin's service-area list (used by onboarding / the
    // settings "service area" editor). Individual locations are otherwise
    // managed one at a time via PATCH/DELETE /admin/work-location/:id.
    if (workLocations) {
      const profile = await tx.adminProfile.findUnique({
        where: { id: adminId },
        select: { country: true },
      });
      if (!profile) throw new AppError(status.NOT_FOUND, "Admin profile not found");
      const tenantCountryIso = countryEnumToIso(profile.country);
      for (const location of workLocations) {
        assertTenantWorkLocationCountry(tenantCountryIso, location.countryIso);
      }

      await tx.workLocation.deleteMany({ where: { adminId } });
      if (workLocations.length > 0) {
        await tx.workLocation.createMany({
          data: workLocations.map(({ countryIso: _countryIso, ...loc }) => ({
            adminId,
            city: loc.city,
            postcode: loc.postcode,
            notes: loc.notes,
          })),
        });
      }
    }
  }, { maxWait: 10_000, timeout: 25_000 });

  await Promise.all([
    redis.del(`admin:profile:${userId}`).catch(() => {}),
    WebsiteProjectionCacheService.invalidateAdminWebsite(adminId),
    ...(scalarFields.businessHours !== undefined ? [invalidateAdminTimezoneCache(adminId)] : []),
  ]);
  return getAdmin(userId);
};

// ── Update a single work location ───────────────────────────────────────────
const updateWorkLocation = async (
  userId: string,
  locationId: string,
  payload: UpdateWorkLocationPayload,
) => {
  const adminId = await findAdminIdOrThrow(userId);

  const location = await prisma.workLocation.findUnique({ where: { id: locationId } });
  if (!location || location.adminId !== adminId) {
    throw new AppError(status.NOT_FOUND, "Work location not found");
  }

  const profile = await prisma.adminProfile.findUnique({
    where: { id: adminId },
    select: { country: true },
  });
  if (!profile) throw new AppError(status.NOT_FOUND, "Admin profile not found");
  assertTenantWorkLocationCountry(countryEnumToIso(profile.country), payload.countryIso);
  const { countryIso: _countryIso, ...locationData } = payload;

  const updated = await prisma.workLocation.update({
    where: { id: locationId },
    data: locationData,
  });
  await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);
  return updated;
};

// ── Delete a single work location ───────────────────────────────────────────
const deleteWorkLocation = async (userId: string, locationId: string) => {
  const adminId = await findAdminIdOrThrow(userId);

  const location = await prisma.workLocation.findUnique({ where: { id: locationId } });
  if (!location || location.adminId !== adminId) {
    throw new AppError(status.NOT_FOUND, "Work location not found");
  }

  await prisma.workLocation.delete({ where: { id: locationId } });
  await WebsiteProjectionCacheService.invalidateAdminWebsite(adminId);

  return { id: locationId, deleted: true };
};

// ── Create the AdminProfile row for a freshly-registered/created admin user ─
const createAdmin = async (
  payload: {
    userId: string;
    businessName: string;
    /** ISO-3166-1 alpha-2 country. Registration supplies this before OTP. */
    country?: string;
    /** Phone / WhatsApp collected in registration wizard Step 2 */
    mobileNumber?: string;
    /** Business type collected in registration wizard Step 1 */
    businessType?: "residential" | "commercial" | "both";
    /** License / Trade ID collected in registration wizard Step 1 */
    licenseNumber?: string;
  },
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => {
  const resolvedCountry = payload.country ? resolveCountryEnum(payload.country) : undefined;
  if (payload.country && !resolvedCountry) {
    throw new AppError(status.BAD_REQUEST, `Unrecognised country: "${payload.country}"`, {
      code: "BUSINESS_COUNTRY_INVALID",
      retryable: false,
      fieldErrors: { country: "Select a supported business country." },
    });
  }
  const regionalDefaults = payload.country ? getCountryRegionalDefaults(payload.country) : undefined;

  return db.adminProfile.create({
    data: {
      userId: payload.userId,
      businessName: payload.businessName,
      ...(resolvedCountry ? { country: resolvedCountry } : {}),
      ...(regionalDefaults?.currency ? { currency: regionalDefaults.currency } : {}),
      // Persist optional wizard fields immediately so they are available
      // to the onboarding flow without an extra PATCH round-trip.
      ...(payload.mobileNumber && {
        mobileNumber: requireE164Phone(payload.mobileNumber, "mobileNumber"),
      }),
      ...(payload.businessType && { businessType: payload.businessType }),
      ...(payload.licenseNumber && { licenseNumber: payload.licenseNumber.trim() }),
    },
  });
};

// ── Get admin usage counts AND plan caps ─────────────────────────────────────

const getAdminUsage = async (adminId: string): Promise<AdminUsageResponse> => {
  const monthStart = startOfMonth(new Date());

  type UsageRow = {
    staffCount: number;
    clientCount: number;
    bookingCountThisMonth: number;
    subscriptionId: string | null;
    planId: string | null;
    extraStaff: number | null;
    extraClient: number | null;
    extraBookingsPerMonth: number | null;
    maxStaff: number | null;
    maxClient: number | null;
    maxBookingsPerMonth: number | null;
  };

  // One tenant-scoped SQL round trip replaces the previous profile lookup plus
  // four independent Prisma statements. The latest-subscription lookup is
  // backed by @@index([adminId, createdAt(sort: Desc)]).
  const rows = await prisma.$queryRaw<UsageRow[]>`
    SELECT
      (SELECT COUNT(*)::int FROM "StaffProfile" sp
        WHERE sp."adminId" = ${adminId} AND sp.status::text = 'ACTIVE') AS "staffCount",
      (SELECT COUNT(*)::int FROM "client" c
        WHERE c."adminId" = ${adminId} AND c.status::text = 'ACTIVE') AS "clientCount",
      (SELECT COUNT(*)::int FROM "booking" b
        WHERE b."adminId" = ${adminId} AND b."createdAt" >= ${monthStart}) AS "bookingCountThisMonth",
      s.id AS "subscriptionId",
      s."planId" AS "planId",
      s."extraStaff" AS "extraStaff",
      s."extraClient" AS "extraClient",
      s."extraBookingsPerMonth" AS "extraBookingsPerMonth",
      p."maxStaff" AS "maxStaff",
      p."maxClient" AS "maxClient",
      p."maxBookingsPerMonth" AS "maxBookingsPerMonth"
    FROM (SELECT 1) anchor
    LEFT JOIN LATERAL (
      SELECT id, "planId", "extraStaff", "extraClient", "extraBookingsPerMonth"
      FROM "Subscription"
      WHERE "adminId" = ${adminId}
      ORDER BY "createdAt" DESC
      LIMIT 1
    ) s ON TRUE
    LEFT JOIN "Plan" p ON p.id = s."planId"
  `;

  const row = rows[0];
  const staffCount = row?.staffCount ?? 0;
  const clientCount = row?.clientCount ?? 0;
  const bookingCountThisMonth = row?.bookingCountThisMonth ?? 0;

  const addExtra = (base: number | null | undefined, extra: number | null | undefined): number | null => {
    if (base === null || base === undefined) return null;
    return base + (extra ?? 0);
  };

  const caps: AdminUsageResponse["caps"] = row?.subscriptionId
    ? {
        staff: addExtra(row.maxStaff, row.extraStaff),
        clients: addExtra(row.maxClient, row.extraClient),
        bookingsPerMonth: addExtra(row.maxBookingsPerMonth, row.extraBookingsPerMonth),
      }
    : { staff: null, clients: null, bookingsPerMonth: null };

  const toPct = (count: number, cap: number | null): number | null => {
    if (cap === null || cap === 0) return null;
    return Math.min(Math.round((count / cap) * 100), 100);
  };

  const pct: AdminUsageResponse["pct"] = {
    staff: toPct(staffCount, caps.staff),
    clients: toPct(clientCount, caps.clients),
    bookingsPerMonth: toPct(bookingCountThisMonth, caps.bookingsPerMonth),
  };

  return {
    staffCount,
    clientCount,
    bookingCountThisMonth,
    caps,
    pct,
    anyNearLimit: [pct.staff, pct.clients, pct.bookingsPerMonth].some((value) => value !== null && value >= 90),
    subscriptionId: row?.subscriptionId ?? null,
    planId: row?.planId ?? null,
  };
};

// ─── Five-step website-first onboarding + Getting Started checklist ───────────

interface OnboardingStepResult {
  key: OnboardingStepKey;
  label: string;
  status: OnboardingStepStatus;
  completed: boolean;
}

interface GettingStartedStepResult {
  key: GettingStartedStepKey;
  label: string;
  completed: boolean;
}

interface GettingStartedResult {
  isComplete: boolean;
  completedCount: number;
  totalCount: number;
  steps: GettingStartedStepResult[];
}

interface WebsiteSetupOffer {
  status: "PROVISIONED" | "DRAFT";
  subdomain: string;
}

export interface OnboardingStatusResult {
  isComplete: boolean;
  completedCount: number;
  totalCount: number;
  skippedCount: number;
  currentStep: number;
  resumeStep: OnboardingStepKey | null;
  savedAt: Date;
  steps: OnboardingStepResult[];
  gettingStarted: GettingStartedResult;
  /**
   * Existing customers may have completed CRM onboarding years before the
   * website feature existed. Phase 21 backfills an unpublished website for
   * them without resetting onboarding. This compact offer lets the dashboard
   * surface that website setup opportunity from the already-cached onboarding
   * request instead of adding another dashboard API call.
   */
  websiteSetupOffer: WebsiteSetupOffer | null;
}

const isLegacySkippable = (
  step: string,
): step is LegacySkippableOnboardingStepKey =>
  (SKIPPABLE_ONBOARDING_STEPS as readonly string[]).includes(step);

/**
 * Compact source of truth for the five-step website-first setup and the
 * optional dashboard checklist. Defaults exist from registration, therefore
 * explicit step progress is persisted instead of inferred from default values.
 */
const getOnboardingStatus = async (
  userId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<OnboardingStatusResult> => {
  const admin = await db.adminProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      updatedAt: true,
      onboardingCompletedAt: true,
      onboardingCompletedSteps: true,
      businessWebsite: {
        select: {
          status: true,
          subdomain: true,
          publishedAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found", {
      code: "ADMIN_PROFILE_NOT_FOUND",
      retryable: false,
    });
  }

  const completed = normalizeCompletedSetupSteps(
    admin.onboardingCompletedSteps,
    admin.onboardingCompletedAt,
  );

  // The setup wizard only consumes the five required steps. Avoid five extra
  // CRM count queries on every step save/refetch; optional checklist counts are
  // only needed once the owner can actually enter the dashboard.
  type OptionalOnboardingFlagsRow = {
    hasServiceArea: boolean;
    hasTeam: boolean;
    hasClient: boolean;
    hasBooking: boolean;
    hasPublishedBookingForm: boolean;
  };
  const optionalRow = admin.onboardingCompletedAt
    ? (await db.$queryRaw<OptionalOnboardingFlagsRow[]>`
        SELECT
          EXISTS (SELECT 1 FROM "WorkLocation" wl WHERE wl."adminId" = ${admin.id}) AS "hasServiceArea",
          EXISTS (SELECT 1 FROM "StaffProfile" sp WHERE sp."adminId" = ${admin.id} AND sp.status = 'ACTIVE') AS "hasTeam",
          EXISTS (SELECT 1 FROM "client" c WHERE c."adminId" = ${admin.id} AND c.status = 'ACTIVE') AS "hasClient",
          EXISTS (SELECT 1 FROM "booking" b WHERE b."adminId" = ${admin.id}) AS "hasBooking",
          EXISTS (SELECT 1 FROM "booking_form" bf WHERE bf."adminId" = ${admin.id} AND bf.published = true) AS "hasPublishedBookingForm"
      `)[0]
    : null;

  const steps: OnboardingStepResult[] = ONBOARDING_STEPS.map((step) => {
    const isCompleted = completed.has(step.key);
    return {
      key: step.key,
      label: step.label,
      status: isCompleted ? "completed" : "pending",
      completed: isCompleted,
    };
  });

  const completedCount = steps.filter((step) => step.completed).length;
  const isComplete = Boolean(admin.onboardingCompletedAt);

  const optionalFlags: Record<
    Exclude<GettingStartedStepKey, OnboardingStepKey>,
    boolean
  > = {
    service_area: optionalRow?.hasServiceArea ?? false,
    team: optionalRow?.hasTeam ?? false,
    client: optionalRow?.hasClient ?? false,
    booking: optionalRow?.hasBooking ?? false,
    online_booking: optionalRow?.hasPublishedBookingForm ?? false,
  };

  const gettingStartedSteps: GettingStartedStepResult[] =
    GETTING_STARTED_STEPS.map((step) => ({
      key: step.key,
      label: step.label,
      completed: REQUIRED_SETUP_KEYS.includes(step.key as OnboardingStepKey)
        ? completed.has(step.key as OnboardingStepKey)
        : optionalFlags[step.key as keyof typeof optionalFlags],
    }));

  const gettingStartedCompletedCount = gettingStartedSteps.filter(
    (step) => step.completed,
  ).length;

  // Do not force legacy customers through the five-step registration wizard
  // again. If their old CRM onboarding is already complete and Phase 21 has
  // provisioned an unpublished site, show a dedicated website setup offer on
  // the dashboard. New registrations have onboardingCompletedAt=null and keep
  // using the normal wizard instead.
  const websiteSetupOffer: WebsiteSetupOffer | null =
    admin.onboardingCompletedAt &&
    admin.businessWebsite &&
    !admin.businessWebsite.publishedAt &&
    (admin.businessWebsite.status === WEBSITE_STATUS.PROVISIONED ||
      admin.businessWebsite.status === WEBSITE_STATUS.DRAFT)
      ? {
          status: admin.businessWebsite.status,
          subdomain: admin.businessWebsite.subdomain,
        }
      : null;

  const firstIncompleteIndex = steps.findIndex((step) => !step.completed);
  const savedAt = admin.businessWebsite?.updatedAt && admin.businessWebsite.updatedAt > admin.updatedAt
    ? admin.businessWebsite.updatedAt
    : admin.updatedAt;

  return {
    isComplete,
    completedCount,
    totalCount: steps.length,
    skippedCount: 0,
    currentStep: isComplete ? steps.length : firstIncompleteIndex === -1 ? steps.length : firstIncompleteIndex + 1,
    resumeStep: isComplete || firstIncompleteIndex === -1 ? null : steps[firstIncompleteIndex]!.key,
    savedAt,
    steps,
    gettingStarted: {
      isComplete: gettingStartedCompletedCount === gettingStartedSteps.length,
      completedCount: gettingStartedCompletedCount,
      totalCount: gettingStartedSteps.length,
      steps: gettingStartedSteps,
    },
    websiteSetupOffer,
  };
};

export const ONBOARDING_BOOTSTRAP_SCHEMA_VERSION = 2 as const;

export interface OnboardingBootstrapResult {
  schemaVersion: 2;
  adminId: string;
  profileVersion: string;
  user: {
    id: string;
    role: string;
    status: string;
  };
  onboarding: {
    currentStep: number;
    completedSteps: OnboardingStepKey[];
    isComplete: boolean;
    savedAt: Date;
  };
  profile: {
    businessName: string;
    businessEmail: string | null;
    mobileNumber: string | null;
    businessDescription: string | null;
    businessHours: BusinessHours | null;
    address: string | null;
    city: string | null;
    postcode: string | null;
    currency: string;
  };
  website: {
    id: string;
    subdomain: string;
    publicUrl: string | null;
    status: string;
    logo: string | null;
    favicon: string | null;
    draftRevisionNumber: number;
    publishedRevisionNumber: number | null;
    templateVersion: string;
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    font: string | null;
    bookingEnabled: boolean;
    templateId: string;
  };
}

/**
 * One-query bootstrap for the onboarding route. This deliberately avoids the
 * Website Studio editor aggregate and never loads pages, assets, revisions,
 * domains, forms or analytics. It also validates the registration invariants
 * that must exist before a verified ADMIN can enter onboarding.
 */
const getOnboardingBootstrap = async (adminId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<OnboardingBootstrapResult> => {
  const admin = await db.adminProfile.findUnique({
    where: { id: adminId },
    select: {
      id: true,
      businessName: true,
      businessEmail: true,
      mobileNumber: true,
      businessDescription: true,
      businessHours: true,
      address: true,
      city: true,
      zipcode: true,
      currency: true,
      updatedAt: true,
      onboardingCompletedAt: true,
      onboardingCompletedSteps: true,
      user: {
        select: { id: true, role: true, status: true },
      },
      businessWebsite: {
        select: {
          id: true,
          subdomain: true,
          status: true,
          logo: true,
          favicon: true,
          draftRevisionNumber: true,
          publishedRevisionNumber: true,
          templateVersion: true,
          primaryColor: true,
          secondaryColor: true,
          accentColor: true,
          font: true,
          bookingEnabled: true,
          templateId: true,
          updatedAt: true,
        },
      },
      subscription: {
        where: { status: SubscriptionStatus.ACTIVE },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found", {
      code: "ADMIN_PROFILE_NOT_FOUND",
      retryable: false,
    });
  }

  if (admin.user.status !== AccountStatus.ACTIVE) {
    throw new AppError(status.CONFLICT, "Account activation is not complete yet.", {
      code: "ACCOUNT_ACTIVATION_INCOMPLETE",
      retryable: true,
    });
  }

  if (admin.subscription.length === 0) {
    throw new AppError(status.CONFLICT, "Subscription provisioning is not complete yet.", {
      code: "SUBSCRIPTION_PROVISIONING_INCOMPLETE",
      retryable: true,
    });
  }

  const website = admin.businessWebsite;
  if (!website) {
    throw new AppError(status.CONFLICT, "Website provisioning is not complete yet.", {
      code: "WEBSITE_PROVISIONING_INCOMPLETE",
      retryable: true,
    });
  }

  const completed = normalizeCompletedSetupSteps(
    admin.onboardingCompletedSteps,
    admin.onboardingCompletedAt,
  );
  const completedSteps = REQUIRED_SETUP_KEYS.filter((step) => completed.has(step));
  const firstIncompleteIndex = REQUIRED_SETUP_KEYS.findIndex((step) => !completed.has(step));
  const isComplete = Boolean(admin.onboardingCompletedAt);
  const currentStep = isComplete
    ? REQUIRED_SETUP_KEYS.length
    : firstIncompleteIndex === -1
      ? REQUIRED_SETUP_KEYS.length
      : firstIncompleteIndex + 1;
  const savedAt = website.updatedAt > admin.updatedAt ? website.updatedAt : admin.updatedAt;
  const parsedBusinessHours = admin.businessHours == null
    ? { success: true as const, data: null }
    : businessHoursSchema.safeParse(admin.businessHours);
  if (!parsedBusinessHours.success) {
    logger.warn("onboarding_legacy_business_hours_normalized", {
      event: "onboarding_legacy_business_hours_normalized",
      tenantHash: hashTelemetryId(admin.id),
      releaseSha: RELEASE_VERSION,
      issueCount: parsedBusinessHours.error.issues.length,
    });
  }

  const profile = onboardingProfile(admin);
  return {
    schemaVersion: ONBOARDING_BOOTSTRAP_SCHEMA_VERSION,
    adminId: admin.id,
    profileVersion: fingerprint(profile),
    user: {
      id: admin.user.id,
      role: admin.user.role,
      status: admin.user.status,
    },
    onboarding: {
      currentStep,
      completedSteps,
      isComplete,
      savedAt,
    },
    profile,
    website: {
      id: website.id,
      subdomain: website.subdomain,
      publicUrl: getCanonicalWebsiteOrigin(website.subdomain),
      status: website.status,
      logo: website.logo,
      favicon: website.favicon,
      draftRevisionNumber: website.draftRevisionNumber,
      publishedRevisionNumber: website.publishedRevisionNumber,
      templateVersion: website.templateVersion,
      primaryColor: website.primaryColor,
      secondaryColor: website.secondaryColor,
      accentColor: website.accentColor,
      font: website.font,
      bookingEnabled: website.bookingEnabled,
      templateId: website.templateId,
    },
  };
};

const hashTelemetryId = (value: string | null | undefined): string | null =>
  value ? createHash("sha256").update(value).digest("hex").slice(0, 24) : null;

/** v1 had strict clients: do not add fields to their payload during rollout. */
export const toLegacyOnboardingBootstrap = (value: OnboardingBootstrapResult) => {
  const { schemaVersion: _schemaVersion, adminId: _adminId, profileVersion: _profileVersion, ...legacy } = value;
  const { favicon: _favicon, draftRevisionNumber: _draft, publishedRevisionNumber: _published, templateVersion: _template, ...website } = value.website;
  return { ...legacy, website };
};

const reportOnboardingClientError = async (
  userId: string,
  knownAdminId: string | null | undefined,
  payload: OnboardingClientErrorPayload,
  requestId: string | null,
): Promise<void> => {
  const adminId = knownAdminId ?? (await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true },
  }))?.id ?? null;
  recordClientReliabilitySignals({
    section: payload.section,
    errorKind: payload.errorKind,
    message: payload.message,
    releaseVersion: payload.releaseVersion || RELEASE_VERSION,
    route: payload.route,
    onboardingStep: payload.onboardingStep ?? null,
    requestId,
    traceId: payload.relatedTraceId ?? null,
  });
  await ErrorMonitor.captureDashboardClientError({
    message: payload.message,
    stack: payload.stack ?? null,
    digest: payload.digest ?? null,
    path: payload.route,
    requestId,
    apiRequestId: payload.apiRequestId ?? null,
    userIdHash: hashTelemetryId(userId),
    tenantIdHash: hashTelemetryId(adminId),
    releaseVersion: payload.releaseVersion || RELEASE_VERSION,
    browser: payload.browser,
    bootstrapSchemaVersion: payload.bootstrapSchemaVersion,
    metadata: {
      section: payload.section,
      errorName: payload.errorName,
      errorKind: payload.errorKind,
      onboardingStep: payload.onboardingStep ?? null,
      componentStack: payload.componentStack ?? null,
      serverReleaseVersion: RELEASE_VERSION,
      relatedTraceId: payload.relatedTraceId ?? null,
    },
  });
};

export interface OnboardingMutationResult {
  onboarding: OnboardingStatusResult;
  website: Awaited<ReturnType<typeof WebsiteService.getWebsiteForAdmin>>;
  publicUrl: string | null;
}

const buildOnboardingMutationResult = async (
  userId: string,
  adminId: string,
): Promise<OnboardingMutationResult> => {
  const [onboarding, website] = await Promise.all([
    getOnboardingStatus(userId),
    WebsiteService.getWebsiteForAdmin(adminId),
  ]);

  void bumpCacheResourceVersions(adminId, [
    CacheResource.onboarding,
    CacheResource.dashboard,
    CacheResource.profile,
  ]);

  return {
    onboarding,
    website,
    publicUrl: website.publicUrl,
  };
};


export interface SaveOnboardingServicesResult extends OnboardingMutationResult {
  schemaVersion: 1;
  services: Array<{
    id: string;
    serviceName: string;
    description: string;
    basePrice: number;
    duration: string;
    category: string;
    status: string;
    onlineBookingEnabled: boolean;
    addOns: unknown;
  }>;
  bookingSetup: Awaited<ReturnType<typeof WebsiteBookingProvisioningService.getSetupByAdminId>>;
  websiteDraft: {
    id: string;
    status: string;
    subdomain: string;
    publicUrl: string | null;
    draftRevisionNumber: number;
    publishedRevisionNumber: number | null;
    bookingEnabled: boolean;
    primaryBookingFormId: string | null;
    bookingShowPrices: boolean;
    bookingShowServiceDuration: boolean;
    bookingShowAvailableSlots: boolean;
    bookingCtaLabel: string;
  };
  nextStep: OnboardingStepKey | null;
}

const onboardingServicesSignature = (payload: SaveOnboardingServicesPayload): string => {
  const canonical = {
    services: payload.services
      .map((service) => ({
        serviceCatalogId: service.serviceCatalogId ?? null,
        serviceName: service.serviceName.trim(),
        description: service.description.trim(),
        basePrice: service.basePrice,
        duration: service.duration.trim(),
        category: service.category,
        onlineBookingEnabled: service.onlineBookingEnabled,
        addOns: [...(service.addOns ?? [])]
          .map((addOn) => ({ name: addOn.name.trim(), price: addOn.price }))
          .sort((a, b) => a.name.localeCompare(b.name, "en-GB")),
      }))
      .sort((a, b) => a.serviceName.localeCompare(b.serviceName, "en-GB", { sensitivity: "base" })),
    booking: {
      ...payload.booking,
      bookingFormId: payload.booking.bookingFormId ?? null,
      ctaLabel: payload.booking.ctaLabel.trim() || "Book Now",
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
};

/**
 * Atomic Services + Online Booking onboarding command. All CRM services,
 * BookingForm wiring, website draft state, revision history and milestone
 * progress commit or roll back as one PostgreSQL transaction.
 *
 * The semantic request signature is stored in the revision reason. Concurrent
 * duplicate submissions serialize on an advisory lock; the later submission
 * sees the matching committed revision and becomes a read-only retry.
 */
const saveOnboardingServices = async (
  userId: string,
  payload: SaveOnboardingServicesPayload,
  context: { requestId?: string | null; traceId?: string | null } = {},
): Promise<SaveOnboardingServicesResult> => {
  const signature = onboardingServicesSignature(payload);
  const revisionReason = `Onboarding services:${signature}`;
  let adminId = "";

  try {
    await prisma.$transaction(
      async (tx) => {
        const admin = await tx.adminProfile.findUnique({
          where: { userId },
          select: {
            id: true,
            onboardingCompletedAt: true,
            onboardingCompletedSteps: true,
            businessWebsite: { select: { id: true } },
          },
        });
    if (!admin) {
      throw new AppError(status.NOT_FOUND, "Admin profile not found", {
        code: "ADMIN_PROFILE_NOT_FOUND",
        retryable: false,
      });
    }
    if (!admin.businessWebsite) {
      throw new AppError(status.CONFLICT, "Website provisioning is not complete yet.", {
        code: "WEBSITE_PROVISIONING_INCOMPLETE",
        retryable: true,
      });
    }
    adminId = admin.id;


    // Serialize this atomic onboarding write with Website Studio draft mutations too.
    // pg_advisory_xact_lock is re-entrant for the same transaction, so the
    // revision helper can safely acquire this lock again later.
    await acquireTextTransactionAdvisoryLock(tx, admin.businessWebsite.id);
    await acquireExtendedTextTransactionAdvisoryLock(tx, `website-booking-provision:${admin.id}`);

    const refreshed = await tx.adminProfile.findUnique({
      where: { id: admin.id },
      select: { onboardingCompletedAt: true, onboardingCompletedSteps: true },
    });
    const completed = normalizeCompletedSetupSteps(
      refreshed?.onboardingCompletedSteps ?? admin.onboardingCompletedSteps,
      refreshed?.onboardingCompletedAt ?? admin.onboardingCompletedAt,
    );
    const servicesIndex = REQUIRED_SETUP_KEYS.indexOf("services");
    const missingPrevious = REQUIRED_SETUP_KEYS
      .slice(0, servicesIndex)
      .find((key) => !completed.has(key));
    if (missingPrevious) {
      throw new AppError(status.CONFLICT, "Complete the previous setup step first.", {
        code: "ONBOARDING_STEP_OUT_OF_ORDER",
        retryable: false,
        fieldErrors: { [missingPrevious]: "Complete this step first" },
      });
    }

    if (payload.booking.enabled && !payload.services.some((service) => service.onlineBookingEnabled)) {
      throw new AppError(status.UNPROCESSABLE_ENTITY, "Enable online booking for at least one selected service.", {
        code: "NO_BOOKABLE_SERVICES",
        retryable: false,
        fieldErrors: { services: "Turn on Online booking for at least one selected service." },
      });
    }

    const latestRevision = await tx.websiteRevision.findFirst({
      where: { websiteId: admin.businessWebsite.id },
      orderBy: { revisionNumber: "desc" },
      select: { reason: true },
    });
    const milestoneAlreadyCommitted = completed.has("services");
    if (latestRevision?.reason === revisionReason && milestoneAlreadyCommitted) return;

    await WebsiteService.ensurePublishedSnapshotBeforeDraftMutationTx(tx, admin.businessWebsite.id);
    await syncServiceCatalogSelectionTx(
      tx,
      admin.id,
      payload.services.map((service) => ({
        ...service,
        status: ServiceStatus.ACTIVE,
      })),
      // Legacy clients cannot prove that their page contains the full catalog.
      // Keep omissions untouched; v2 uses explicit guarded removals.
      {},
    );

    await WebsiteBookingProvisioningService.configureForAdminTx(tx, admin.id, payload.booking);

    if (!milestoneAlreadyCommitted) {
      const nextCompleted = REQUIRED_SETUP_KEYS.filter(
        (key) => completed.has(key) || key === "services",
      );
      await tx.adminProfile.update({
        where: { id: admin.id },
        data: { onboardingCompletedSteps: nextCompleted },
      });
    }

    await WebsiteService.createRevisionSnapshotTx(
      tx,
      admin.businessWebsite.id,
      userId,
      revisionReason,
    );
    }, { maxWait: 15_000, timeout: 35_000 });
  } catch (error) {
    const expectedClientError = error instanceof AppError && error.statusCode < 500 && error.retryable !== true;
    if (!expectedClientError) {
      recordProductReliabilitySignal({
        code: "ONBOARDING_TRANSACTION_FAILURE",
        releaseVersion: RELEASE_VERSION,
        route: "/api/v1/admin/onboarding/services",
        onboardingStep: "services",
        requestId: context.requestId ?? null,
        traceId: context.traceId ?? null,
      });
      logger.error("onboarding_transaction_failure", {
        event: "product_reliability_signal",
        signal: "ONBOARDING_TRANSACTION_FAILURE",
        releaseSha: RELEASE_VERSION,
        onboardingStep: "services",
        requestId: context.requestId ?? null,
        traceId: context.traceId ?? null,
        tenantHash: hashTelemetryId(adminId),
        errorCode: error instanceof AppError ? error.code ?? null : null,
        errorMessage: error instanceof Error ? error.message.slice(0, 400) : "Unknown transaction failure",
      });
    }
    throw error;
  }

  await Promise.all([
    invalidateServiceCatalogReadModels(adminId),
    WebsiteProjectionCacheService.invalidateAdminWebsite(adminId),
    redis.del(`admin:profile:${userId}`).catch(() => {}),
  ]);

  const [base, services, bookingSetup] = await Promise.all([
    buildOnboardingMutationResult(userId, adminId),
    prisma.serviceCatalog.findMany({
      where: { adminId, status: ServiceStatus.ACTIVE },
      select: {
        id: true,
        serviceName: true,
        description: true,
        basePrice: true,
        duration: true,
        category: true,
        status: true,
        onlineBookingEnabled: true,
        addOns: true,
      },
      orderBy: [{ createdAt: "asc" }, { serviceName: "asc" }],
    }),
    WebsiteBookingProvisioningService.getSetupByAdminId(adminId),
  ]);

  return {
    ...base,
    schemaVersion: 1,
    services,
    bookingSetup,
    websiteDraft: {
      id: base.website.id,
      status: base.website.status,
      subdomain: base.website.subdomain,
      publicUrl: base.publicUrl,
      draftRevisionNumber: base.website.draftRevisionNumber,
      publishedRevisionNumber: base.website.publishedRevisionNumber,
      bookingEnabled: base.website.bookingEnabled,
      primaryBookingFormId: base.website.primaryBookingFormId,
      bookingShowPrices: base.website.bookingShowPrices,
      bookingShowServiceDuration: base.website.bookingShowServiceDuration,
      bookingShowAvailableSlots: base.website.bookingShowAvailableSlots,
      bookingCtaLabel: base.website.bookingCtaLabel,
    },
    nextStep: base.onboarding.resumeStep,
  };
};

/** Persist one setup milestone after its underlying resource has been saved. */
const completeOnboardingStep = async (
  userId: string,
  step: OnboardingStepKey | LegacyOnboardingStepKey,
): Promise<OnboardingMutationResult> => {
  const canonicalStep = canonicalOnboardingStep(step);
  const adminId = await prisma.$transaction(async tx => {
    const owner = await lockOnboardingOwnerTx(tx, userId);
    if (canonicalStep === "services") {
      await lockServiceCatalogTx(tx, owner.id);
      const service = await tx.serviceCatalog.findFirst({
        where: { adminId: owner.id, status: ServiceStatus.ACTIVE }, select: { id: true },
      });
      if (!service) throw new AppError(status.CONFLICT, "Add at least one service before continuing.", {
        code: "ONBOARDING_SERVICE_REQUIRED", retryable: false,
        fieldErrors: { services: "Add at least one active service" },
      });
    }
    await completeStepTx(tx, owner, canonicalStep);
    await tx.businessWebsite.updateMany({
      where: { id: owner.websiteId, status: WEBSITE_STATUS.PROVISIONED },
      data: { status: WEBSITE_STATUS.DRAFT },
    });
    return owner.id;
  }, { maxWait: 10_000, timeout: 25_000 });
  return buildOnboardingMutationResult(userId, adminId);
};

/**
 * Used by "Skip setup and use defaults". This marks every setup step complete
 * but deliberately leaves onboardingCompletedAt untouched. Website launch is
 * the atomic publication boundary and owns the final completion timestamp, so
 * a failed publish can never leave an account marked finished without a live site.
 */
const skipWebsiteOnboardingSetup = async (
  userId: string,
): Promise<OnboardingMutationResult> => {
  const adminId = await prisma.$transaction(async tx => {
    const owner = await lockOnboardingOwnerTx(tx, userId);
    if (!owner.onboardingCompletedAt) {
      await tx.adminProfile.update({ where: { id: owner.id }, data: { onboardingCompletedSteps: [...REQUIRED_SETUP_KEYS] } });
    }
    return owner.id;
  }, { maxWait: 10_000, timeout: 25_000 });
  return buildOnboardingMutationResult(userId, adminId);
};

/** Called only after the website has successfully published. */
const finalizeOnboardingSetup = async (
  userId: string,
): Promise<OnboardingMutationResult> => {
  const adminId = await prisma.$transaction(async tx => {
    const owner = await lockOnboardingOwnerTx(tx, userId);
    const admin = await tx.adminProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      onboardingCompletedAt: true,
      onboardingCompletedSteps: true,
      businessWebsite: { select: { status: true, publishedAt: true } },
    },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found", {
      code: "ADMIN_PROFILE_NOT_FOUND",
      retryable: false,
    });
  }

  if (!admin.onboardingCompletedAt) {
    const completed = normalizeCompletedSetupSteps(
      admin.onboardingCompletedSteps,
      admin.onboardingCompletedAt,
    );
    const missing = REQUIRED_SETUP_KEYS.filter((key) => !completed.has(key));

    if (missing.length > 0) {
      throw new AppError(status.CONFLICT, "Complete the five setup steps before entering the dashboard.", {
        code: "ACCOUNT_SETUP_INCOMPLETE",
        retryable: false,
        fieldErrors: Object.fromEntries(missing.map((key) => [key, "This step is not complete"])),
      });
    }

    if (admin.businessWebsite?.status !== "PUBLISHED" || !admin.businessWebsite.publishedAt) {
      throw new AppError(status.CONFLICT, "Launch your website before finishing setup.", {
        code: "WEBSITE_NOT_PUBLISHED",
        retryable: true,
        fieldErrors: { review_launch: "Launch the website to finish setup" },
      });
    }

    await tx.adminProfile.update({
      where: { id: admin.id },
      data: { onboardingCompletedAt: new Date() },
    });
    logger.info("onboarding_completed", { event: "onboarding_completed", tenantHash: hashTelemetryId(admin.id), releaseSha: RELEASE_VERSION });
  }

    return owner.id;
  }, { maxWait: 10_000, timeout: 25_000 });
  return buildOnboardingMutationResult(userId, adminId);
};

// ─── Legacy skip endpoints ───────────────────────────────────────────────────
// Kept temporarily so an older deployed frontend does not crash while clients
// roll forward. Skip choices no longer affect the five-step setup or the new
// Getting Started checklist, which is always derived from real data.
const skipOnboardingStep = async (
  userId: string,
  step: LegacySkippableOnboardingStepKey,
) => {
  if (!isLegacySkippable(step)) {
    throw new AppError(status.BAD_REQUEST, "This setup step cannot be skipped", {
      code: "SETUP_STEP_REQUIRED",
      retryable: false,
    });
  }

  await prisma.$transaction(async tx => {
    const owner = await lockOnboardingOwnerTx(tx, userId);
    const admin = await tx.adminProfile.findUniqueOrThrow({ where: { id: owner.id }, select: { skippedSteps: true } });
    const skippedSteps = [...new Set([...admin.skippedSteps, step])];
    await tx.adminProfile.update({ where: { id: owner.id }, data: { skippedSteps } });
  }, { maxWait: 10_000, timeout: 25_000 });

  return { step, skipped: true, deprecated: true };
};

const skipAllOnboarding = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
  await prisma.$transaction(async tx => {
    const owner = await lockOnboardingOwnerTx(tx, userId);
    const admin = await tx.adminProfile.findUniqueOrThrow({ where: { id: owner.id }, select: { skippedSteps: true } });
    const skippedSteps = [...new Set([...admin.skippedSteps, ...SKIPPABLE_ONBOARDING_STEPS])];
    await tx.adminProfile.update({ where: { id: owner.id }, data: { skippedSteps } });
  }, { maxWait: 10_000, timeout: 25_000 });

  return getOnboardingStatus(userId);
};

export const adminService = {
  getAdmin,
  updateAdmin,
  updateWorkLocation,
  deleteWorkLocation,
  createAdmin,
  getAdminUsage,
  getOnboardingStatus,
  getOnboardingBootstrap,
  saveOnboardingServices,
  reportOnboardingClientError,
  completeOnboardingStep,
  skipWebsiteOnboardingSetup,
  finalizeOnboardingSetup,
  skipOnboardingStep,
  skipAllOnboarding,
};

export { getAdminUsage };
