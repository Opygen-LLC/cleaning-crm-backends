import { createHash } from "node:crypto";
import { startOfMonth } from "date-fns";
import status from "http-status";
import { prisma } from "../../lib/prisma/prisma";
import logger from "../../lib/logger";
import AppError from "../../errorHelper/AppError";
import { countryEnumToIso, resolveCountryEnum } from "../../lib/constants/countryIsoMap";
import {
  GETTING_STARTED_STEPS,
  ONBOARDING_STEPS,
  SKIPPABLE_ONBOARDING_STEPS,
} from "./admin.constant";
import redis from "../../config/redis";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { WEBSITE_STATUS } from "../Website/websiteLifecycle";
import { WebsiteService } from "../Website/website.service";
import { WEBSITE_BASE_DOMAIN, RELEASE_VERSION } from "../../config/ENV";
import { ErrorMonitor } from "../../lib/monitoring/errorMonitor";
import { AccountStatus, SubscriptionStatus } from "../../generated/prisma/enums";
import type {
  GettingStartedStepKey,
  LegacySkippableOnboardingStepKey,
  OnboardingStepKey,
  OnboardingStepStatus,
  OnboardingClientErrorPayload,
  UpdateAdminPayload,
  UpdateWorkLocationPayload,
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

  const result = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.image ?? undefined,
    ...profileFields,
    postcode: profileFields.zipcode ?? null,
    countryIso: countryEnumToIso(profileFields.country),
    workLocations,
  };

  await redis.setex(cacheKey, 300, JSON.stringify(result)).catch(() => {});

  return result;
};

// ── Update admin profile (scalar fields + optional bulk work-location set) ──
const updateAdmin = async (userId: string, payload: UpdateAdminPayload) => {
  const adminId = await findAdminIdOrThrow(userId);

  const { workLocations, country, postcode, zipcode, ...scalarFields } = payload;

  const data: Record<string, unknown> = {
    ...scalarFields,
    ...(postcode !== undefined || zipcode !== undefined
      ? { zipcode: postcode ?? zipcode }
      : {}),
  };

  // "country" arrives as an ISO-3166-1 alpha-2 code (or already a valid enum
  // value) from the frontend's country picker — resolve it to the real
  // Prisma enum member here rather than trusting the client to send it.
  if (country !== undefined) {
    if (country === null) {
      data.country = null;
    } else {
      const resolved = resolveCountryEnum(country);
      if (!resolved) {
        throw new AppError(status.BAD_REQUEST, `Unrecognised country: "${country}"`);
      }
      data.country = resolved;
    }
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.adminProfile.update({ where: { id: adminId }, data });
    }

    // The bulk `workLocations` field on the profile payload is a full
    // replace of the admin's service-area list (used by onboarding / the
    // settings "service area" editor). Individual locations are otherwise
    // managed one at a time via PATCH/DELETE /admin/work-location/:id.
    if (workLocations) {
      await tx.workLocation.deleteMany({ where: { adminId } });
      if (workLocations.length > 0) {
        await tx.workLocation.createMany({
          data: workLocations.map((loc) => ({
            adminId,
            city: loc.city,
            postcode: loc.postcode,
            notes: loc.notes,
          })),
        });
      }
    }
  });

  await Promise.all([
    redis.del(`admin:profile:${userId}`).catch(() => {}),
    WebsiteProjectionCacheService.invalidateAdminWebsite(adminId),
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

  const updated = await prisma.workLocation.update({
    where: { id: locationId },
    data: payload,
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
    /** Phone / WhatsApp collected in registration wizard Step 2 */
    mobileNumber?: string;
    /** Business type collected in registration wizard Step 1 */
    businessType?: "residential" | "commercial" | "both";
    /** License / Trade ID collected in registration wizard Step 1 */
    licenseNumber?: string;
  },
  db: any = prisma,
) => {
  return db.adminProfile.create({
    data: {
      userId: payload.userId,
      businessName: payload.businessName,
      // Persist optional wizard fields immediately so they are available
      // to the onboarding flow without an extra PATCH round-trip.
      ...(payload.mobileNumber && { mobileNumber: payload.mobileNumber }),
      ...(payload.businessType && { businessType: payload.businessType }),
      // licenseNumber is stored in the generic `website` text field as a
      // lightweight placeholder until a dedicated column is added via migration.
      ...(payload.licenseNumber && { website: payload.licenseNumber }),
    },
  });
};

// ── Get admin usage counts AND plan caps ─────────────────────────────────────

const getAdminUsage = async (userId: string): Promise<AdminUsageResponse> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!admin) {
    throw new AppError(404, "Admin profile not found");
  }

  const adminId = admin.id;
  const monthStart = startOfMonth(new Date());

  // ── Parallel: counts + latest subscription ─────────────────────────────────
  const [staffCount, clientCount, bookingCountThisMonth, sub] =
    await Promise.all([
      prisma.staffProfile.count({
        where: { adminId, status: "ACTIVE" },
      }),
      prisma.client.count({
        where: { adminId, status: "ACTIVE" },
      }),
      prisma.booking.count({
        where: { adminId, createdAt: { gte: monthStart } },
      }),
      prisma.subscription.findFirst({
        where: { adminId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          extraStaff: true,
          extraClient: true,
          extraBookingsPerMonth: true,
          plan: {
            select: {
              id: true,
              maxStaff: true,
              maxClient: true,
              maxBookingsPerMonth: true,
            },
          },
        },
      }),
    ]);

  // ── Compute caps (null = unlimited) ────────────────────────────────────────
  //
  // When there is no subscription row (free trial / super-admin created
  // account) we return null caps so the frontend shows "Unlimited" bars.
  let caps: AdminUsageResponse["caps"] = {
    staff: null,
    clients: null,
    bookingsPerMonth: null,
  };

  if (sub) {
    const addExtra = (
      base: number | null | undefined,
      extra: number,
    ): number | null => {
      if (base === null || base === undefined) return null;
      return base + extra;
    };

    caps = {
      staff: addExtra(sub.plan.maxStaff, sub.extraStaff),
      clients: addExtra(sub.plan.maxClient, sub.extraClient),
      bookingsPerMonth: addExtra(
        sub.plan.maxBookingsPerMonth,
        sub.extraBookingsPerMonth,
      ),
    };
  }

  // ── Compute percentages ────────────────────────────────────────────────────
  const toPct = (count: number, cap: number | null): number | null => {
    if (cap === null || cap === 0) return null;
    return Math.min(Math.round((count / cap) * 100), 100);
  };

  const pct: AdminUsageResponse["pct"] = {
    staff: toPct(staffCount, caps.staff),
    clients: toPct(clientCount, caps.clients),
    bookingsPerMonth: toPct(bookingCountThisMonth, caps.bookingsPerMonth),
  };

  const anyNearLimit = [pct.staff, pct.clients, pct.bookingsPerMonth].some(
    (p) => p !== null && p >= 90,
  );

  return {
    staffCount,
    clientCount,
    bookingCountThisMonth,
    caps,
    pct,
    anyNearLimit,
    subscriptionId: sub?.id ?? null,
    planId: sub?.plan.id ?? null,
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

const REQUIRED_SETUP_KEYS = ONBOARDING_STEPS.map((step) => step.key);

const isLegacySkippable = (
  step: string,
): step is LegacySkippableOnboardingStepKey =>
  (SKIPPABLE_ONBOARDING_STEPS as readonly string[]).includes(step);

const normalizeCompletedSetupSteps = (
  persisted: string[],
  onboardingCompletedAt: Date | null,
): Set<OnboardingStepKey> => {
  if (onboardingCompletedAt) return new Set(REQUIRED_SETUP_KEYS);
  const allowed = new Set<string>(REQUIRED_SETUP_KEYS);
  return new Set(
    persisted.filter((step): step is OnboardingStepKey => allowed.has(step)),
  );
};

/**
 * Compact source of truth for the five-step website-first setup and the
 * optional dashboard checklist. Defaults exist from registration, therefore
 * explicit step progress is persisted instead of inferred from default values.
 */
const getOnboardingStatus = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
  const admin = await prisma.adminProfile.findUnique({
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
    ? (await prisma.$queryRaw<OptionalOnboardingFlagsRow[]>`
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

export const ONBOARDING_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export interface OnboardingBootstrapResult {
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
    businessHours: unknown;
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
const getOnboardingBootstrap = async (userId: string): Promise<OnboardingBootstrapResult> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
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

  return {
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
    profile: {
      businessName: admin.businessName,
      businessEmail: admin.businessEmail,
      mobileNumber: admin.mobileNumber,
      businessDescription: admin.businessDescription,
      businessHours: admin.businessHours,
      address: admin.address,
      city: admin.city,
      postcode: admin.zipcode,
      currency: admin.currency,
    },
    website: {
      id: website.id,
      subdomain: website.subdomain,
      publicUrl: WEBSITE_BASE_DOMAIN
        ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}`
        : null,
      status: website.status,
      logo: website.logo,
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

  return {
    onboarding,
    website,
    publicUrl: website.publicUrl,
  };
};

/** Persist one setup milestone after its underlying resource has been saved. */
const completeOnboardingStep = async (
  userId: string,
  step: OnboardingStepKey,
): Promise<OnboardingMutationResult> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      onboardingCompletedAt: true,
      onboardingCompletedSteps: true,
    },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found", {
      code: "ADMIN_PROFILE_NOT_FOUND",
      retryable: false,
    });
  }

  if (admin.onboardingCompletedAt) return buildOnboardingMutationResult(userId, admin.id);

  const stepIndex = REQUIRED_SETUP_KEYS.indexOf(step);
  if (stepIndex === -1) {
    throw new AppError(status.BAD_REQUEST, "Unknown onboarding step", {
      code: "INVALID_ONBOARDING_STEP",
      retryable: false,
    });
  }

  const completed = normalizeCompletedSetupSteps(
    admin.onboardingCompletedSteps,
    admin.onboardingCompletedAt,
  );

  const missingPrevious = REQUIRED_SETUP_KEYS
    .slice(0, stepIndex)
    .find((key) => !completed.has(key));
  if (missingPrevious) {
    throw new AppError(status.CONFLICT, "Complete the previous setup step first.", {
      code: "ONBOARDING_STEP_OUT_OF_ORDER",
      retryable: false,
      fieldErrors: { [missingPrevious]: "Complete this step first" },
    });
  }

  if (step === "services") {
    const service = await prisma.serviceCatalog.findFirst({
      where: { adminId: admin.id },
      select: { id: true },
    });
    if (!service) {
      throw new AppError(status.CONFLICT, "Add at least one service before continuing.", {
        code: "ONBOARDING_SERVICE_REQUIRED",
        retryable: false,
        fieldErrors: { services: "Add at least one service" },
      });
    }
  }

  if (step === "business_profile" && !completed.has(step)) {
    logger.info("onboarding_started", { event: "onboarding_started", tenantHash: hashTelemetryId(admin.id), releaseSha: RELEASE_VERSION });
  }

  await prisma.$transaction(async (tx) => {
    if (!completed.has(step)) {
      await tx.adminProfile.update({
        where: { id: admin.id },
        data: { onboardingCompletedSteps: { push: step } },
      });
    }

    // Registration creates a PROVISIONED website. As soon as onboarding makes
    // progress it becomes an explicit draft, even when Step 1 only changed CRM
    // business fields rather than website fields directly.
    await tx.businessWebsite.updateMany({
      where: { adminId: admin.id, status: WEBSITE_STATUS.PROVISIONED },
      data: { status: WEBSITE_STATUS.DRAFT },
    });
  });

  return buildOnboardingMutationResult(userId, admin.id);
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
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, onboardingCompletedAt: true },
  });
  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found", {
      code: "ADMIN_PROFILE_NOT_FOUND",
      retryable: false,
    });
  }

  if (!admin.onboardingCompletedAt) {
    await prisma.adminProfile.update({
      where: { id: admin.id },
      data: { onboardingCompletedSteps: [...REQUIRED_SETUP_KEYS] },
    });
  }

  return buildOnboardingMutationResult(userId, admin.id);
};

/** Called only after the website has successfully published. */
const finalizeOnboardingSetup = async (
  userId: string,
): Promise<OnboardingMutationResult> => {
  const admin = await prisma.adminProfile.findUnique({
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
        fieldErrors: { template: "Launch the website to finish setup" },
      });
    }

    await prisma.adminProfile.update({
      where: { id: admin.id },
      data: { onboardingCompletedAt: new Date() },
    });
    logger.info("onboarding_completed", { event: "onboarding_completed", tenantHash: hashTelemetryId(admin.id), releaseSha: RELEASE_VERSION });
  }

  return buildOnboardingMutationResult(userId, admin.id);
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

  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, skippedSteps: true },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found", {
      code: "ADMIN_PROFILE_NOT_FOUND",
      retryable: false,
    });
  }

  if (!admin.skippedSteps.includes(step)) {
    await prisma.adminProfile.update({
      where: { id: admin.id },
      data: { skippedSteps: { push: step } },
    });
  }

  return { step, skipped: true, deprecated: true };
};

const skipAllOnboarding = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, skippedSteps: true },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found", {
      code: "ADMIN_PROFILE_NOT_FOUND",
      retryable: false,
    });
  }

  const newlySkipped = SKIPPABLE_ONBOARDING_STEPS.filter(
    (step) => !admin.skippedSteps.includes(step),
  );

  if (newlySkipped.length > 0) {
    await prisma.adminProfile.update({
      where: { id: admin.id },
      data: { skippedSteps: { push: [...newlySkipped] } },
    });
  }

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
  reportOnboardingClientError,
  completeOnboardingStep,
  skipWebsiteOnboardingSetup,
  finalizeOnboardingSetup,
  skipOnboardingStep,
  skipAllOnboarding,
};

export { getAdminUsage };
