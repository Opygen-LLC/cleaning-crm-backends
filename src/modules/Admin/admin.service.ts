import { startOfMonth } from "date-fns";
import status from "http-status";
import { prisma } from "../../lib/prisma/prisma";
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
import type {
  GettingStartedStepKey,
  LegacySkippableOnboardingStepKey,
  OnboardingStepKey,
  OnboardingStepStatus,
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
    countryIso: countryEnumToIso(profileFields.country),
    workLocations,
  };

  await redis.setex(cacheKey, 300, JSON.stringify(result)).catch(() => {});

  return result;
};

// ── Update admin profile (scalar fields + optional bulk work-location set) ──
const updateAdmin = async (userId: string, payload: UpdateAdminPayload) => {
  const adminId = await findAdminIdOrThrow(userId);

  const { workLocations, country, ...scalarFields } = payload;

  const data: Record<string, unknown> = { ...scalarFields };

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
  payload: { userId: string; businessName: string },
  db: any = prisma,
) => {
  return db.adminProfile.create({
    data: {
      userId: payload.userId,
      businessName: payload.businessName,
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

interface OnboardingStatusResult {
  isComplete: boolean;
  completedCount: number;
  totalCount: number;
  skippedCount: number;
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
      onboardingCompletedAt: true,
      onboardingCompletedSteps: true,
      businessWebsite: {
        select: {
          status: true,
          subdomain: true,
          publishedAt: true,
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
  const [serviceAreaCount, teamCount, clientCount, bookingCount, publishedBookingFormCount] =
    admin.onboardingCompletedAt
      ? await Promise.all([
          prisma.workLocation.count({ where: { adminId: admin.id } }),
          prisma.staffProfile.count({ where: { adminId: admin.id, status: "ACTIVE" } }),
          prisma.client.count({ where: { adminId: admin.id, status: "ACTIVE" } }),
          prisma.booking.count({ where: { adminId: admin.id } }),
          prisma.bookingForm.count({ where: { adminId: admin.id, published: true } }),
        ])
      : [0, 0, 0, 0, 0];

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
    service_area: serviceAreaCount > 0,
    team: teamCount > 0,
    client: clientCount > 0,
    booking: bookingCount > 0,
    online_booking: publishedBookingFormCount > 0,
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

  return {
    isComplete,
    completedCount,
    totalCount: steps.length,
    skippedCount: 0,
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

/** Persist one setup milestone after its underlying resource has been saved. */
const completeOnboardingStep = async (
  userId: string,
  step: OnboardingStepKey,
): Promise<OnboardingStatusResult> => {
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

  if (admin.onboardingCompletedAt) return getOnboardingStatus(userId);

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
    const serviceCount = await prisma.serviceCatalog.count({
      where: { adminId: admin.id },
    });
    if (serviceCount === 0) {
      throw new AppError(status.CONFLICT, "Add at least one service before continuing.", {
        code: "ONBOARDING_SERVICE_REQUIRED",
        retryable: false,
        fieldErrors: { services: "Add at least one service" },
      });
    }
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

  return getOnboardingStatus(userId);
};

/**
 * Used by "Skip setup and use defaults". It deliberately does not stamp
 * onboardingCompletedAt; the frontend publishes the already-provisioned site
 * first and only then calls finalize, so a publication failure cannot leave a
 * supposedly-finished account with no live website.
 */
const skipWebsiteOnboardingSetup = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
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

  return getOnboardingStatus(userId);
};

/** Called only after the website has successfully published. */
const finalizeOnboardingSetup = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
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
  }

  return getOnboardingStatus(userId);
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
  completeOnboardingStep,
  skipWebsiteOnboardingSetup,
  finalizeOnboardingSetup,
  skipOnboardingStep,
  skipAllOnboarding,
};

export { getAdminUsage };
