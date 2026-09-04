import redis from "../../config/redis";
import logger from "../logger";
import type { IRequestUser } from "../../types/requestUser.interface";
import { recordCacheVersionInvalidation } from "../monitoring/operationalMetrics";

import { BoundedTtlCache } from "./boundedTtlCache";

export const CacheResource = Object.freeze({
  clients: "clients",
  leads: "leads",
  followUps: "followUps",
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
  onboarding: "onboarding",
  website: "website",
  quotes: "quotes",
  estimates: "estimates",
  forms: "forms",
  superAdmin: "superAdmin",
} as const);

export type CacheResourceName = (typeof CacheResource)[keyof typeof CacheResource];

const versionKey = (tenantId: string, resource: CacheResourceName) =>
  `tenant:${tenantId}:${resource}:version`;

const localVersionCache = new BoundedTtlCache<number>({ maxEntries: 10_000 });
const LOCAL_VERSION_TTL_MS = 2_000;

export const cacheTenantIdForUser = (user: Pick<IRequestUser, "id" | "adminId">): string =>
  user.adminId ?? user.id;

export async function getCacheResourceVersion(
  tenantId: string,
  resource: CacheResourceName,
): Promise<number> {
  if (!tenantId) return 0;
  const localKey = `${tenantId}:${resource}`;
  const cachedLocal = localVersionCache.get(localKey);
  if (cachedLocal !== undefined) return cachedLocal;

  try {
    const raw = await redis.get(versionKey(tenantId, resource));
    const parsed = raw ? Number(raw) : 0;
    const version = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    localVersionCache.set(localKey, version, LOCAL_VERSION_TTL_MS);
    return version;
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
  for (const resource of unique) {
    localVersionCache.delete(`${tenantId}:${resource}`);
  }

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
