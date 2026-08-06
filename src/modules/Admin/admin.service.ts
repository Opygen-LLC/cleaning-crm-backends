import { startOfMonth } from "date-fns";
import status from "http-status";
import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { resolveCountryEnum } from "../../lib/constants/countryIsoMap";
import { ONBOARDING_STEPS, SKIPPABLE_ONBOARDING_STEPS } from "./admin.constant";
import redis from "../../config/redis";
import type {
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

  await redis.del(`admin:profile:${userId}`).catch(() => {});
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

  return prisma.workLocation.update({
    where: { id: locationId },
    data: payload,
  });
};

// ── Delete a single work location ───────────────────────────────────────────
const deleteWorkLocation = async (userId: string, locationId: string) => {
  const adminId = await findAdminIdOrThrow(userId);

  const location = await prisma.workLocation.findUnique({ where: { id: locationId } });
  if (!location || location.adminId !== adminId) {
    throw new AppError(status.NOT_FOUND, "Work location not found");
  }

  await prisma.workLocation.delete({ where: { id: locationId } });

  return { id: locationId, deleted: true };
};

// ── Create the AdminProfile row for a freshly-registered/created admin user ─
const createAdmin = async (payload: { userId: string; businessName: string }) => {
  return prisma.adminProfile.create({
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

// ─── Guided setup wizard ──────────────────────────────────────────────────────

interface OnboardingStepResult {
  key: OnboardingStepKey;
  label: string;
  status: OnboardingStepStatus;
  completed: boolean;
}

interface OnboardingStatusResult {
  isComplete: boolean;
  skippedCount: number;
  steps: OnboardingStepResult[];
}

const isSkippable = (step: OnboardingStepKey): boolean =>
  (SKIPPABLE_ONBOARDING_STEPS as readonly string[]).includes(step);

const getOnboardingStatus = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      skippedSteps: true,
      onboardingCompletedAt: true,
      address: true,
      city: true,
      mobileNumber: true,
      businessType: true,
    },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  // Onboarding completion is persisted once reached so it never regresses
  // (e.g. if the admin later deletes their only client). Once set, derive
  // every step's status purely from skippedSteps — no need to re-run five
  // count queries on every dashboard load.
  if (admin.onboardingCompletedAt) {
    const steps: OnboardingStepResult[] = ONBOARDING_STEPS.map((s) => {
      const skipped = admin.skippedSteps.includes(s.key);
      const stepStatus: OnboardingStepStatus = skipped ? "skipped" : "completed";
      return {
        key: s.key,
        label: s.label,
        status: stepStatus,
        completed: stepStatus === "completed",
      };
    });

    return {
      isComplete: true,
      skippedCount: admin.skippedSteps.length,
      steps,
    };
  }

  const businessProfileComplete = Boolean(
    admin.address && admin.city && admin.mobileNumber && admin.businessType,
  );

  const [serviceCount, serviceAreaCount, teamCount, clientCount, bookingCount] =
    await Promise.all([
      prisma.serviceCatalog.count({ where: { adminId: admin.id } }),
      prisma.workLocation.count({ where: { adminId: admin.id } }),
      prisma.staffProfile.count({ where: { adminId: admin.id, status: "ACTIVE" } }),
      prisma.client.count({ where: { adminId: admin.id, status: "ACTIVE" } }),
      prisma.booking.count({ where: { adminId: admin.id } }),
    ]);

  const completionByKey: Record<OnboardingStepKey, boolean> = {
    business_profile: businessProfileComplete,
    service: serviceCount > 0,
    service_area: serviceAreaCount > 0,
    team: teamCount > 0,
    client: clientCount > 0,
    booking: bookingCount > 0,
  };

  const steps: OnboardingStepResult[] = ONBOARDING_STEPS.map((s) => {
    const completed = completionByKey[s.key];

    let stepStatus: OnboardingStepStatus;
    if (completed) {
      stepStatus = "completed";
    } else if (isSkippable(s.key) && admin.skippedSteps.includes(s.key)) {
      // Real data always outranks a stale skip choice, but if there's no
      // data yet the earlier skip decision still stands.
      stepStatus = "skipped";
    } else {
      stepStatus = "pending";
    }

    return { key: s.key, label: s.label, status: stepStatus, completed };
  });

  const skippedCount = steps.filter((s) => s.status === "skipped").length;
  const isComplete = steps.every(
    (s) => s.status === "completed" || s.status === "skipped",
  );

  if (isComplete) {
    await prisma.adminProfile.update({
      where: { id: admin.id },
      data: { onboardingCompletedAt: new Date() },
    });
  }

  return { isComplete, skippedCount, steps };
};

const skipOnboardingStep = async (userId: string, step: OnboardingStepKey) => {
  // Mandatory steps 1-3 can never be skipped, including by hitting the API
  // directly — this is the real enforcement point, not just the Zod schema.
  // Checked before any DB access so an invalid request never touches prisma.
  if (!isSkippable(step)) {
    throw new AppError(
      status.BAD_REQUEST,
      `"${step}" is a required step and cannot be skipped`,
    );
  }

  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, skippedSteps: true, onboardingCompletedAt: true },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  // Idempotent no-op: already skipped, or onboarding is already fully done.
  if (admin.onboardingCompletedAt || admin.skippedSteps.includes(step)) {
    return { step, skipped: true };
  }

  await prisma.adminProfile.update({
    where: { id: admin.id },
    data: { skippedSteps: { push: step } },
  });

  return { step, skipped: true };
};

const skipAllOnboarding = async (
  userId: string,
): Promise<OnboardingStatusResult> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, skippedSteps: true, onboardingCompletedAt: true },
  });

  if (!admin) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  if (!admin.onboardingCompletedAt) {
    const newlySkipped = SKIPPABLE_ONBOARDING_STEPS.filter(
      (step) => !admin.skippedSteps.includes(step),
    );

    if (newlySkipped.length > 0) {
      await prisma.adminProfile.update({
        where: { id: admin.id },
        data: { skippedSteps: { push: newlySkipped } },
      });
    }
  }

  // Re-derive status from the DB so `isComplete` reflects whether the
  // mandatory (non-skippable) steps were already satisfied for real.
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
  skipOnboardingStep,
  skipAllOnboarding,
};

export { getAdminUsage };
