import {
  ServiceCategory,
  ServiceStatus,
  ServiceType,
} from "../../generated/prisma/enums";
import type { Prisma } from "../../generated/prisma/client";
import { lockServiceCatalogTx } from "./serviceCatalogConcurrency";

export type RecommendedServiceState = "INSTALLED" | "ARCHIVED" | "MISSING";

export interface RecommendedCleaningServicePreset {
  key: string;
  serviceName: string;
  slug: string;
  description: string;
  basePrice: number;
  duration: string;
  category: ServiceCategory;
  status: ServiceStatus;
  onlineBookingEnabled: boolean;
  legacyServiceType: ServiceType | null;
}

/**
 * Canonical cleaning-company starter catalogue.
 *
 * Prices are deliberately zero and every preset starts inactive/offline. A
 * tenant must enter its own price before activation. This avoids presenting a
 * made-up market price on a newly provisioned public website.
 */
export const RECOMMENDED_CLEANING_SERVICES: readonly RecommendedCleaningServicePreset[] = [
  {
    key: "regular-cleaning",
    serviceName: "Regular Cleaning",
    slug: "regular-cleaning",
    description: "Routine home cleaning for recurring or one-off maintenance visits.",
    basePrice: 0,
    duration: "2h",
    category: ServiceCategory.RESIDENTIAL,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: ServiceType.RESIDENTIAL_CLEAN,
  },
  {
    key: "deep-cleaning",
    serviceName: "Deep Cleaning",
    slug: "deep-cleaning",
    description: "A detailed top-to-bottom clean for homes that need extra attention.",
    basePrice: 0,
    duration: "4h",
    category: ServiceCategory.RESIDENTIAL,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: ServiceType.DEEP_CLEAN,
  },
  {
    key: "move-in-move-out-cleaning",
    serviceName: "Move-In/Move-Out Cleaning",
    slug: "move-in-move-out-cleaning",
    description: "Detailed cleaning for properties before moving in or after moving out.",
    basePrice: 0,
    duration: "4h",
    category: ServiceCategory.RESIDENTIAL,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: ServiceType.MOVE_IN_OUT_CLEAN,
  },
  {
    key: "office-commercial-cleaning",
    serviceName: "Office/Commercial Cleaning",
    slug: "office-commercial-cleaning",
    description: "Flexible cleaning for offices, workplaces, shops, and other commercial spaces.",
    basePrice: 0,
    duration: "3h",
    category: ServiceCategory.COMMERCIAL,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: ServiceType.OFFICE_CLEAN,
  },
  {
    key: "airbnb-short-term-rental-cleaning",
    serviceName: "Airbnb/Short-Term Rental Cleaning",
    slug: "airbnb-short-term-rental-cleaning",
    description: "Turnover cleaning for short-term rentals between guest stays.",
    basePrice: 0,
    duration: "2h",
    category: ServiceCategory.RESIDENTIAL,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: null,
  },
  {
    key: "post-construction-cleaning",
    serviceName: "Post-Construction Cleaning",
    slug: "post-construction-cleaning",
    description: "Detailed cleanup after building, renovation, or refurbishment work.",
    basePrice: 0,
    duration: "5h",
    category: ServiceCategory.SPECIALIST,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: null,
  },
  {
    key: "window-cleaning",
    serviceName: "Window Cleaning",
    slug: "window-cleaning",
    description: "Interior or exterior window and glass cleaning for a clear finish.",
    basePrice: 0,
    duration: "2h",
    category: ServiceCategory.SPECIALIST,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: ServiceType.WINDOW_CLEAN,
  },
  {
    key: "carpet-upholstery-cleaning",
    serviceName: "Carpet/Upholstery Cleaning",
    slug: "carpet-upholstery-cleaning",
    description: "Specialist cleaning for carpets, rugs, sofas, and upholstered furniture.",
    basePrice: 0,
    duration: "3h",
    category: ServiceCategory.SPECIALIST,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: ServiceType.CARPET_CLEAN,
  },
  {
    key: "one-time-spring-cleaning",
    serviceName: "One-Time/Spring Cleaning",
    slug: "one-time-spring-cleaning",
    description: "A comprehensive seasonal or one-time clean tailored to the property.",
    basePrice: 0,
    duration: "4h",
    category: ServiceCategory.RESIDENTIAL,
    status: ServiceStatus.INACTIVE,
    onlineBookingEnabled: false,
    legacyServiceType: null,
  },
];

interface ExistingRecommendedCandidate {
  id: string;
  serviceName: string;
  slug: string;
  archivedAt: Date | null;
}

const normalizedName = (value: string) => value.trim().toLocaleLowerCase("en-GB");

const buildCandidateIndexes = (rows: ExistingRecommendedCandidate[]) => ({
  bySlug: new Map(rows.map((row) => [row.slug, row])),
  byName: new Map(rows.map((row) => [normalizedName(row.serviceName), row])),
});

const findPresetCandidate = (
  preset: RecommendedCleaningServicePreset,
  indexes: ReturnType<typeof buildCandidateIndexes>,
) => indexes.bySlug.get(preset.slug) ?? indexes.byName.get(normalizedName(preset.serviceName));

export const describeRecommendedCleaningServices = (
  rows: ExistingRecommendedCandidate[],
) => {
  const indexes = buildCandidateIndexes(rows);
  const services = RECOMMENDED_CLEANING_SERVICES.map((preset) => {
    const existing = findPresetCandidate(preset, indexes);
    const state: RecommendedServiceState = !existing
      ? "MISSING"
      : existing.archivedAt
        ? "ARCHIVED"
        : "INSTALLED";
    return {
      ...preset,
      state,
      serviceCatalogId: existing?.id ?? null,
    };
  });

  return {
    services,
    total: services.length,
    installedCount: services.filter((item) => item.state === "INSTALLED").length,
    archivedCount: services.filter((item) => item.state === "ARCHIVED").length,
    missingCount: services.filter((item) => item.state !== "INSTALLED").length,
  };
};

/**
 * Idempotently installs recommended services inside the caller's transaction.
 * Archived presets are restored rather than duplicated so their historical
 * identity remains intact. User-edited names/descriptions/prices are preserved
 * on restore; only archive/availability state is reset to a safe setup state.
 */
export const seedRecommendedCleaningServicesTx = async (
  tx: Prisma.TransactionClient,
  adminId: string,
) => {
  await lockServiceCatalogTx(tx, adminId);

  const existing = await tx.serviceCatalog.findMany({
    where: { adminId },
    select: { id: true, serviceName: true, slug: true, archivedAt: true },
  });
  const indexes = buildCandidateIndexes(existing);

  let createdCount = 0;
  let restoredCount = 0;
  let skippedCount = 0;

  for (const preset of RECOMMENDED_CLEANING_SERVICES) {
    const candidate = findPresetCandidate(preset, indexes);
    if (candidate) {
      if (candidate.archivedAt) {
        const restored = await tx.serviceCatalog.update({
          where: { id: candidate.id },
          data: {
            archivedAt: null,
            status: ServiceStatus.INACTIVE,
            onlineBookingEnabled: false,
          },
          select: { id: true, serviceName: true, slug: true, archivedAt: true },
        });
        indexes.bySlug.set(restored.slug, restored);
        indexes.byName.set(normalizedName(restored.serviceName), restored);
        restoredCount += 1;
      } else {
        skippedCount += 1;
      }
      continue;
    }

    const created = await tx.serviceCatalog.create({
      data: {
        adminId,
        serviceName: preset.serviceName,
        slug: preset.slug,
        description: preset.description,
        basePrice: preset.basePrice,
        duration: preset.duration,
        category: preset.category,
        status: preset.status,
        onlineBookingEnabled: preset.onlineBookingEnabled,
        legacyServiceType: preset.legacyServiceType,
        addOns: [],
      },
      select: { id: true, serviceName: true, slug: true, archivedAt: true },
    });
    indexes.bySlug.set(created.slug, created);
    indexes.byName.set(normalizedName(created.serviceName), created);
    createdCount += 1;
  }

  return {
    createdCount,
    restoredCount,
    skippedCount,
    total: RECOMMENDED_CLEANING_SERVICES.length,
  };
};
