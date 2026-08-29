export const SERVICE_CATEGORIES = [
  "Residential",
  "Commercial",
  "Specialist",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/**
 * Historical releases allowed arbitrary category strings. Normalize those
 * rows at the API boundary so old tenants cannot break current clients while
 * all new writes use the canonical three-category contract.
 */
export const normalizeServiceCategory = (value: string): ServiceCategory => {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");

  if (
    normalized.includes("commercial") ||
    normalized.includes("office") ||
    normalized.includes("business")
  ) {
    return "Commercial";
  }

  if (
    normalized.includes("residential") ||
    normalized.includes("standard") ||
    normalized.includes("home") ||
    normalized.includes("domestic") ||
    normalized.includes("tenancy") ||
    normalized.includes("move_in") ||
    normalized.includes("move_out")
  ) {
    return "Residential";
  }

  return "Specialist";
};
