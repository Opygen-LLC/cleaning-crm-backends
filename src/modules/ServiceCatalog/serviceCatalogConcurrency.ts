import { createHash } from "node:crypto";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import type { Prisma } from "../../generated/prisma/client";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";

/** All catalog writers, including booking default provisioning, use this lock.
 * Lock order when more than one is needed: website -> booking -> catalog.
 */
export const lockServiceCatalogTx = (tx: Prisma.TransactionClient, adminId: string) =>
  acquireExtendedTextTransactionAdvisoryLock(tx, `service-catalog:${adminId}`);

/** Deterministic JSON, preserving null vs omitted and array order (including add-ons). */
export const canonicalJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => [k, normalize(v)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
};

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const onboardingCatalogSelect = {
  id: true, serviceName: true, description: true, basePrice: true, duration: true,
  category: true, status: true, onlineBookingEnabled: true, addOns: true, updatedAt: true,
} as const;

/** Normalize the historical priceGbp spelling without losing an existing price.
 * Fail closed on corrupt stored JSON rather than presenting an empty list that
 * the next save would silently erase. The version still hashes the raw rows.
 */
export const readOnboardingAddOns = (value: unknown): Array<{ name: string; price: number }> => {
  if (value === null || value === undefined) return [];
  const invalid = () => new AppError(status.CONFLICT, "A saved service has invalid add-ons. Repair its catalog data before continuing.", {
    code: "SERVICE_ADDONS_DATA_INVALID", retryable: false,
    fieldErrors: { services: "Saved add-ons could not be read safely; no changes have been applied." },
  });
  if (!Array.isArray(value)) throw invalid();
  return value.map(item => {
    if (!item || typeof item !== "object") throw invalid();
    const record = item as Record<string, unknown>;
    const price = record.price ?? record.priceGbp;
    if (typeof record.name !== "string" || typeof price !== "number" || !Number.isFinite(price) || price < 0) throw invalid();
    return { name: record.name, price };
  });
};

/** No Redis and no page limit: the token attests to the complete tenant catalog. */
export const readOnboardingCatalogTx = async (tx: Prisma.TransactionClient, adminId: string) => {
  const rows = await tx.serviceCatalog.findMany({
    where: { adminId }, select: onboardingCatalogSelect, orderBy: { id: "asc" },
  });
  return {
    version: fingerprint(rows),
    complete: true as const,
    services: rows.map(({ updatedAt: _updatedAt, ...row }) => ({ ...row, addOns: readOnboardingAddOns(row.addOns) })),
  };
};
