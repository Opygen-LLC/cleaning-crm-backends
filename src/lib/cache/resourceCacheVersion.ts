import redis from "../../config/redis";
import logger from "../logger";
import type { IRequestUser } from "../../types/requestUser.interface";
import { recordCacheVersionInvalidation } from "../monitoring/operationalMetrics";

export const CacheResource = Object.freeze({
  clients: "clients",
  leads: "leads",
  bookings: "bookings",
  jobs: "jobs",
  staff: "staff",
  dashboard: "dashboard",
  profile: "profile",
  notifications: "notifications",
  reports: "reports",
  invoices: "invoices",
  payments: "payments",
  services: "services",
} as const);

export type CacheResourceName = (typeof CacheResource)[keyof typeof CacheResource];

const versionKey = (tenantId: string, resource: CacheResourceName) =>
  `tenant:${tenantId}:${resource}:version`;

export const cacheTenantIdForUser = (user: Pick<IRequestUser, "id" | "adminId">): string =>
  user.adminId ?? user.id;

export async function getCacheResourceVersion(
  tenantId: string,
  resource: CacheResourceName,
): Promise<number> {
  if (!tenantId) return 0;
  try {
    const raw = await redis.get(versionKey(tenantId, resource));
    const parsed = raw ? Number(raw) : 0;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    // Redis is an acceleration layer. Returning version 0 makes the response
    // cache fall back to its normal miss path when Redis itself is unavailable.
    return 0;
  }
}

export async function bumpCacheResourceVersions(
  tenantId: string,
  resources: readonly CacheResourceName[],
): Promise<void> {
  if (!tenantId || resources.length === 0) return;

  const unique = [...new Set(resources)];
  try {
    await Promise.all(unique.map((resource) => redis.incr(versionKey(tenantId, resource))));
    recordCacheVersionInvalidation(unique, true);
  } catch (error) {
    recordCacheVersionInvalidation(unique, false);
    // Never roll back a committed DB mutation because Redis is unavailable.
    // A Redis outage also makes the GET cache miss naturally; once Redis is
    // healthy again the short response TTLs bound any residual old generation.
    logger.warn(
      `[CACHE] Resource version bump skipped for tenant ${tenantId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function bumpCacheResourcesForUser(
  user: Pick<IRequestUser, "id" | "adminId">,
  resources: readonly CacheResourceName[],
): Promise<void> {
  await bumpCacheResourceVersions(cacheTenantIdForUser(user), resources);
}
