import { ServiceCategory } from "../../generated/prisma/enums";

export const SERVICE_CATEGORIES = [
  ServiceCategory.RESIDENTIAL,
  ServiceCategory.COMMERCIAL,
  ServiceCategory.SPECIALIST,
] as const;

export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  [ServiceCategory.RESIDENTIAL]: "Residential",
  [ServiceCategory.COMMERCIAL]: "Commercial",
  [ServiceCategory.SPECIALIST]: "Specialist",
};

/**
 * Historical releases accepted free-form category strings. Keep one defensive
 * normalizer for migrations/rolling deploys, while every new database/API
 * value uses the generated Prisma ServiceCategory enum.
 */
export const normalizeServiceCategory = (value: string | ServiceCategory): ServiceCategory => {
  const normalized = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");

  if (
    normalized === "commercial" ||
    normalized.includes("office") ||
    normalized.includes("business")
  ) {
    return ServiceCategory.COMMERCIAL;
  }

  if (
    normalized === "residential" ||
    normalized.includes("standard") ||
    normalized.includes("home") ||
    normalized.includes("domestic") ||
    normalized.includes("tenancy") ||
    normalized.includes("move_in") ||
    normalized.includes("move_out")
  ) {
    return ServiceCategory.RESIDENTIAL;
  }

  if (normalized === "specialist" || normalized === "specialty") {
    return ServiceCategory.SPECIALIST;
  }

  // Unknown legacy categories are deliberately contained rather than exposed
  // as arbitrary strings. Specialist is the least misleading catch-all.
  return ServiceCategory.SPECIALIST;
};

export const serviceCategoryLabel = (value: string | ServiceCategory): string =>
  SERVICE_CATEGORY_LABELS[normalizeServiceCategory(value)];
