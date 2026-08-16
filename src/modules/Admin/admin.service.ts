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
    const resolved = resolveCountryEnum(country);
    if (!resolved) {
      throw new AppError(status.BAD_REQUEST, `Unrecognised country: "${country}"`);
    }
    data.country = resolved;
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

// ─── Three-step account setup + Getting Started checklist ─────────────────────

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

interface OnboardingStatusResult {
  isComplete: boolean;
  completedCount: number;
  totalCount: number;
  /** Kept as zero for backwards compatibility with Phase 1 clients. */
  skippedCount: number;
  steps: OnboardingStepResult[];
  gettingStarted: GettingStartedResult;
}

interface SetupCompletionFlags {
  business_profile: boolean;
  service: boolean;
  service_area: boolean;
  team: boolean;
  client: boolean;
  booking: boolean;
  online_booking: boolean;
}

const isLegacySkippable = (
  step: string,
): step is LegacySkippableOnboardingStepKey =>
  (SKIPPABLE_ONBOARDING_STEPS as readonly string[]).includes(step);

/**
 * Return one compact source of truth for both:
 *  - the required three-step account setup, and
 *  - the optional Getting Started checklist shown inside the dashboard.
 *
 * Once onboardingCompletedAt has been stamped, the first three flags are
 * trusted as complete so dashboard loads only need the four optional count
 * queries. This avoids re-counting services/locations forever while still
 * keeping the optional checklist based on real CRM data.
 */
const getOnboardingStatus = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      onboardingCompletedAt: true,
      businessName: true,
      city: true,
      country: true,
      mobileNumber: true,
      businessType: true,
    },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found", {
      code: "ADMIN_PROFILE_NOT_FOUND",
      retryable: false,
    });
  }

  let flags: SetupCompletionFlags;

  if (admin.onboardingCompletedAt) {
    const [teamCount, clientCount, bookingCount, publishedBookingFormCount] =
      await Promise.all([
        prisma.staffProfile.count({
          where: { adminId: admin.id, status: "ACTIVE" },
        }),
        prisma.client.count({
          where: { adminId: admin.id, status: "ACTIVE" },
        }),
        prisma.booking.count({ where: { adminId: admin.id } }),
        prisma.bookingForm.count({
          where: { adminId: admin.id, published: true },
        }),
      ]);

    flags = {
      business_profile: true,
      service: true,
      service_area: true,
      team: teamCount > 0,
      client: clientCount > 0,
      booking: bookingCount > 0,
      online_booking: publishedBookingFormCount > 0,
    };
  } else {
    // Business name is collected during registration. The setup step only
    // requires the operational details needed by the rest of the CRM; street
    // address and postcode are deliberately optional to keep first-run setup
    // quick for mobile/service-area businesses.
    const businessProfileComplete = Boolean(
      admin.businessName?.trim() &&
        admin.businessType?.trim() &&
        admin.mobileNumber?.trim() &&
        admin.city?.trim() &&
        admin.country,
    );

    const [
      serviceCount,
      serviceAreaCount,
      teamCount,
      clientCount,
      bookingCount,
      publishedBookingFormCount,
    ] = await Promise.all([
      prisma.serviceCatalog.count({ where: { adminId: admin.id } }),
      prisma.workLocation.count({ where: { adminId: admin.id } }),
      prisma.staffProfile.count({
        where: { adminId: admin.id, status: "ACTIVE" },
      }),
      prisma.client.count({
        where: { adminId: admin.id, status: "ACTIVE" },
      }),
      prisma.booking.count({ where: { adminId: admin.id } }),
      prisma.bookingForm.count({
        where: { adminId: admin.id, published: true },
      }),
    ]);

    flags = {
      business_profile: businessProfileComplete,
      service: serviceCount > 0,
      service_area: serviceAreaCount > 0,
      team: teamCount > 0,
      client: clientCount > 0,
      booking: bookingCount > 0,
      online_booking: publishedBookingFormCount > 0,
    };
  }

  const steps: OnboardingStepResult[] = ONBOARDING_STEPS.map((step) => {
    const completed = flags[step.key];
    return {
      key: step.key,
      label: step.label,
      status: completed ? "completed" : "pending",
      completed,
    };
  });

  const completedCount = steps.filter((step) => step.completed).length;
  const isComplete = completedCount === steps.length;

  // Stamp once, when all three required setup steps exist for real. This is
  // the only persisted setup state needed; optional checklist items remain
  // live and may naturally change over time.
  if (isComplete && !admin.onboardingCompletedAt) {
    await prisma.adminProfile.update({
      where: { id: admin.id },
      data: { onboardingCompletedAt: new Date() },
    });
  }

  const gettingStartedSteps: GettingStartedStepResult[] =
    GETTING_STARTED_STEPS.map((step) => ({
      key: step.key,
      label: step.label,
      completed: flags[step.key],
    }));

  const gettingStartedCompletedCount = gettingStartedSteps.filter(
    (step) => step.completed,
  ).length;

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
  };
};

/**
 * Called once after the third setup screen is saved. It re-validates setup
 * from database state and gives the client a deterministic finish action
 * without requiring a status refetch after every individual setup step.
 */
const finalizeOnboardingSetup = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
  const result = await getOnboardingStatus(userId);

  if (!result.isComplete) {
    const fieldErrors: Record<string, string> = {};
    for (const step of result.steps) {
      if (!step.completed) {
        fieldErrors[step.key] = `${step.label} is not complete`;
      }
    }

    throw new AppError(
      status.CONFLICT,
      "Complete the three required setup steps before entering the dashboard.",
      {
        code: "ACCOUNT_SETUP_INCOMPLETE",
        retryable: false,
        fieldErrors,
      },
    );
  }

  return result;
};

// ─── Legacy skip endpoints ───────────────────────────────────────────────────
// Kept temporarily so an older deployed frontend does not crash while clients
// roll forward. Skip choices no longer affect the three-step setup or the new
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
  finalizeOnboardingSetup,
  skipOnboardingStep,
  skipAllOnboarding,
};

export { getAdminUsage };
