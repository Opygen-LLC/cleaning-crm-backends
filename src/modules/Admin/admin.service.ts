import status from "http-status";
import { deleteFileFromCloudinary } from "../../config/cloudinary";
import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { resolveCountryEnum } from "../../lib/constants/countryIsoMap";
import {
  OnboardingStepKey,
  OnboardingStepStatus,
  UpdateAdminPayload,
  UpdateWorkLocationPayload,
} from "./admin.interface";
import { ONBOARDING_STEPS, SKIPPABLE_ONBOARDING_STEPS } from "./admin.constant";
import { geocodeAddressSafely } from "../../lib/utils/geocoding";

/**
 * [Phase 2 — location-aware dispatch] Best-effort geocode of a work
 * location's city/postcode. Never throws — service-area creation must
 * succeed even when the geocoder can't resolve it.
 */
const geocodeWorkLocation = async (city: string, postcode?: string | null) => {
  const address = [city, postcode].filter(Boolean).join(", ");
  if (!address) return {};
  const geo = await geocodeAddressSafely(address);
  if (!geo) return {};
  return {
    latitude: geo.latitude,
    longitude: geo.longitude,
    geocodedAt: new Date(),
  };
};

const createAdmin = async (payload: {
  userId: string;
  businessName: string;
}) => {
  const { userId, businessName } = payload;

  const existing = await prisma.adminProfile.findUnique({
    where: { userId },
  });

  if (existing) {
    throw new Error("Admin already exists");
  }

  const admin = await prisma.adminProfile.create({
    data: {
      businessName,
      userId,
    },
  });

  //? Subscription trial for 15 days

  return admin;
};

const getAdmin = async (userId: string) => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    include: {
      workLocations: true,
    },
  });

  if (!admin) {
    throw new Error("Admin profile not found");
  }

  return admin;
};

const updateAdmin = async (userId: string, payload: UpdateAdminPayload) => {
  const { workLocations, ...adminData } = payload;

  // Resolve country (ISO-3166-1 alpha-2 code from the frontend, or an
  // already-valid enum value) to the real Country enum member up front,
  // so a bad/unsupported country fails fast with a clear message instead
  // of surfacing as an opaque Prisma error mid-transaction.
  if (adminData.country !== undefined) {
    const resolved = resolveCountryEnum(adminData.country);
    if (!resolved) {
      throw new AppError(
        status.BAD_REQUEST,
        `Unsupported country: "${adminData.country}"`,
      );
    }
    adminData.country = resolved;
  }

  return await prisma.$transaction(async (tx) => {
    const admin = await tx.adminProfile.findUnique({
      where: { userId },
    });

    if (!admin) {
      throw new Error("Admin profile not found");
    }

    let updatedAdmin = admin;

    const cleanAdminData = Object.fromEntries(
      Object.entries(adminData).filter(([_, v]) => v !== undefined),
    );

    if (adminData.businessLogo && admin.businessLogo) {
      await deleteFileFromCloudinary(admin.businessLogo);
    }

    // ✅ Only update if adminData has at least one field
    if (Object.keys(cleanAdminData).length > 0) {
      updatedAdmin = await tx.adminProfile.update({
        where: { userId },
        data: cleanAdminData,
      });
    }

    // ✅ Handle workLocations separately
    if (workLocations?.length) {
      const existingLocations = await tx.workLocation.findMany({
        where: {
          adminId: admin.id,
          city: { in: workLocations.map((loc) => loc.city) },
        },
      });

      // Get existing city names
      const existingCities = new Set(existingLocations.map((loc) => loc.city));

      // Filter only new cities
      const newLocations = workLocations.filter(
        (loc) => !existingCities.has(loc.city),
      );

      // Create only non-existing ones. Geocoded up front (in parallel)
      // since createMany can't run an async transform per row.
      if (newLocations.length) {
        const geocoded = await Promise.all(
          newLocations.map(async (loc) => ({
            city: loc.city,
            postcode: loc.postcode,
            notes: loc.notes,
            adminId: admin.id,
            ...(await geocodeWorkLocation(loc.city, loc.postcode)),
          })),
        );

        await tx.workLocation.createMany({
          data: geocoded,
        });
      }
    }

    // ✅ Return final state
    return await tx.adminProfile.findUnique({
      where: { userId },
      include: {
        workLocations: true,
      },
    });
  });
};

const updateWorkLocation = async (
  userId: string,
  locationId: string,
  payload: UpdateWorkLocationPayload,
) => {
  return await prisma.$transaction(async (tx) => {
    const admin = await tx.adminProfile.findUnique({
      where: { userId },
    });

    if (!admin) {
      throw new Error("Admin profile not found");
    }

    const workLocation = await tx.workLocation.findFirst({
      where: {
        id: locationId,
        adminId: admin.id,
      },
    });

    if (!workLocation) {
      throw new Error("Work location not found");
    }

    const geo =
      payload.city !== undefined || payload.postcode !== undefined
        ? await geocodeWorkLocation(
            payload.city ?? workLocation.city,
            payload.postcode ?? workLocation.postcode,
          )
        : {};

    return await tx.workLocation.update({
      where: { id: locationId },
      data: { ...payload, ...geo },
    });
  });
};

const deleteWorkLocation = async (userId: string, locationId: string) => {
  return await prisma.$transaction(async (tx) => {
    const admin = await tx.adminProfile.findUnique({
      where: { userId },
    });

    if (!admin) {
      throw new Error("Admin profile not found");
    }

    const workLocation = await tx.workLocation.findFirst({
      where: {
        id: locationId,
        adminId: admin.id,
      },
    });

    if (!workLocation) {
      throw new Error("Work location not found");
    }

    return await tx.workLocation.delete({
      where: { id: locationId },
    });
  });
};

// ─── Get admin usage counts (staff / clients / bookings this month) ───────────

const getAdminUsage = async (userId: string) => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!admin) {
    throw new Error("Admin profile not found");
  }

  const adminId = admin.id;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [staffCount, clientCount, bookingCountThisMonth] = await Promise.all([
    prisma.staffProfile.count({
      where: { adminId, status: "ACTIVE" },
    }),
    prisma.client.count({
      where: { adminId, status: "ACTIVE" },
    }),
    prisma.booking.count({
      where: { adminId, createdAt: { gte: monthStart } },
    }),
  ]);

  return { staffCount, clientCount, bookingCountThisMonth };
};

// ─── Guided setup wizard status ────────────────────────────────────────────────
//
// Steps are auto-detected from real data — a step is "completed" once the
// corresponding record(s) actually exist, not from a manually-ticked flag.
// This means admins who already had data before this feature shipped skip
// straight past whichever steps they'd already done.
//
// Steps 4-6 (team / client / booking) can also be explicitly *skipped* —
// tracked in `admin.skippedSteps` — which is a distinct state from
// "pending": the admin made a deliberate choice to come back to it later,
// rather than simply not having gotten there yet. Steps 1-3 can never be
// skipped (enforced in skipOnboardingStep below), so they only ever report
// "completed" or "pending".
//
// A step's rendered status is "completed" whenever its underlying data
// exists — even if it was skipped first and then done later — since real
// data always outranks a stale skip choice.
//
// Once every step is either completed or (for steps 4-6) skipped, we stamp
// `onboardingCompletedAt` so the wizard can never reopen later just because
// the admin deleted the data that originally satisfied a step (e.g. their
// only client).

const buildStepStatus = (
  completed: boolean,
  skipped: boolean,
): OnboardingStepStatus => {
  if (completed) return "completed";
  if (skipped) return "skipped";
  return "pending";
};

const getOnboardingStatus = async (userId: string) => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
  });

  if (!admin) {
    throw new Error("Admin profile not found");
  }

  const skippedSet = new Set(admin.skippedSteps as OnboardingStepKey[]);

  // Already fully completed previously — short-circuit, no need to recount.
  // Mandatory steps 1-3 must have been "completed" (real data) to have
  // reached this state in the first place; steps 4-6 were either
  // completed or skipped — admin.skippedSteps still tells us which, at no
  // extra query cost, so we don't lose that distinction for the dashboard.
  if (admin.onboardingCompletedAt) {
    const steps = ONBOARDING_STEPS.map((s) => {
      const isSkippable = (
        SKIPPABLE_ONBOARDING_STEPS as readonly string[]
      ).includes(s.key);
      const skipped = isSkippable && skippedSet.has(s.key);
      return {
        ...s,
        status: buildStepStatus(!skipped, skipped),
        completed: !skipped,
      };
    });

    return {
      isComplete: true,
      completedCount: steps.filter((s) => s.status === "completed").length,
      skippedCount: steps.filter((s) => s.status === "skipped").length,
      totalCount: ONBOARDING_STEPS.length,
      steps,
    };
  }

  const adminId = admin.id;

  const [
    serviceCount,
    workLocationCount,
    staffCount,
    clientCount,
    bookingCount,
  ] = await Promise.all([
    prisma.serviceCatalog.count({ where: { adminId } }),
    prisma.workLocation.count({ where: { adminId } }),
    prisma.staffProfile.count({ where: { adminId } }),
    prisma.client.count({ where: { adminId } }),
    prisma.booking.count({ where: { adminId } }),
  ]);

  const completedByKey: Record<
    (typeof ONBOARDING_STEPS)[number]["key"],
    boolean
  > = {
    business_profile: Boolean(
      admin.address && admin.city && admin.mobileNumber && admin.businessType,
    ),
    service: serviceCount > 0,
    service_area: workLocationCount > 0,
    team: staffCount > 0,
    client: clientCount > 0,
    booking: bookingCount > 0,
  };

  const steps = ONBOARDING_STEPS.map((s) => {
    const completed = completedByKey[s.key];
    const skipped = skippedSet.has(s.key);
    return {
      ...s,
      status: buildStepStatus(completed, skipped),
      // Kept for backwards compatibility with any existing frontend
      // reading the old boolean field — "completed" here means
      // "satisfied" (either real data exists, or the step was
      // legitimately skipped), which is what gates wizard completion.
      completed: completed || skipped,
    };
  });

  const completedCount = steps.filter((s) => s.status === "completed").length;
  const skippedCount = steps.filter((s) => s.status === "skipped").length;
  const isComplete = steps.every((s) => s.status !== "pending");

  if (isComplete) {
    await prisma.adminProfile.update({
      where: { id: adminId },
      data: { onboardingCompletedAt: new Date() },
    });
  }

  return {
    isComplete,
    completedCount,
    skippedCount,
    totalCount: steps.length,
    steps,
  };
};

// ─── Skip a step (steps 4-6 only) ──────────────────────────────────────────
//
// Mandatory steps (business_profile / service / service_area) are rejected
// here regardless of what the client sends — this is the real enforcement
// point; the zod schema only checks the step name is one of the six known
// keys, not that it's skippable, precisely so this check can't be bypassed
// by calling the API directly.

const skipOnboardingStep = async (userId: string, step: OnboardingStepKey) => {
  if (!(SKIPPABLE_ONBOARDING_STEPS as readonly string[]).includes(step)) {
    throw new AppError(
      status.BAD_REQUEST,
      `"${step}" is a required setup step and cannot be skipped.`,
    );
  }

  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, skippedSteps: true, onboardingCompletedAt: true },
  });

  if (!admin) {
    throw new Error("Admin profile not found");
  }

  // Idempotent — already skipped (or the wizard is already done, in which
  // case there's nothing meaningful left to persist) — no write needed.
  if (admin.onboardingCompletedAt || admin.skippedSteps.includes(step)) {
    return { step, skipped: true };
  }

  await prisma.adminProfile.update({
    where: { id: admin.id },
    data: { skippedSteps: { push: step } },
  });

  return { step, skipped: true };
};

const skipAllOnboarding = async (userId: string) => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true, onboardingCompletedAt: true },
  });

  if (!admin) {
    throw new Error("Admin profile not found");
  }

  if (!admin.onboardingCompletedAt) {
    await prisma.adminProfile.update({
      where: { id: admin.id },
      data: { onboardingCompletedAt: new Date() },
    });
  }

  return { isComplete: true };
};

export const adminService = {
  createAdmin,
  getAdmin,
  updateAdmin,
  updateWorkLocation,
  deleteWorkLocation,
  getAdminUsage,
  getOnboardingStatus,
  skipOnboardingStep,
  skipAllOnboarding,
};

