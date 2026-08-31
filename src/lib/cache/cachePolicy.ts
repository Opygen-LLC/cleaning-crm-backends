import { createHash } from "node:crypto";

/**
 * Shared Redis namespace + TTL policy for tenant-scoped runtime caches.
 *
 * Short-lived read models use jitter so hundreds of tenants do not expire on
 * the same second after a deploy or traffic spike. Mutation-sensitive website
 * caches still use explicit invalidation in their owning services.
 */
export const CacheNamespaces = Object.freeze({
  authContext: (userId: string) => `auth-context:${userId}`,
  subscription: (adminId: string) => `subscription:${adminId}`,
  entitlements: (adminId: string) => `entitlements:${adminId}`,
  websiteHost: (host: string) => `website-host:${host}`,
  websiteProjection: (websiteId: string) => `website-projection:${websiteId}`,
  websiteStudio: (adminId: string, surface: string) => `website-studio:${adminId}:${surface}`,
  websiteStudioOverview: (adminId: string) => `website-studio-overview:${adminId}`,
  dashboardSummary: (adminId: string, rangeKey: string) => `dashboard-summary:${adminId}:${rangeKey}`,
  serviceCatalog: (adminId: string) => `service-catalog:${adminId}`,
  bookingForm: (formId: string) => `booking-form:${formId}`,
});

export const CacheTtl = Object.freeze({
  authContext: 300,
  subscription: 300,
  entitlements: 300,
  dashboardSummary: 45,
  serviceCatalog: 300,
  bookingForm: 300,
});

/**
 * Returns a bounded TTL around `baseSeconds`.
 * A deterministic salt can be supplied when stable spread per key is useful.
 */
export function jitterTtl(
  baseSeconds: number,
  options: { ratio?: number; salt?: string } = {},
): number {
  const base = Math.max(1, Math.floor(baseSeconds));
  const ratio = Math.min(0.45, Math.max(0, options.ratio ?? 0.2));
  const spread = Math.max(1, Math.floor(base * ratio));

  let unit: number;
  if (options.salt) {
    const digest = createHash("sha256").update(options.salt).digest();
    unit = digest.readUInt32BE(0) / 0xffffffff;
  } else {
    unit = Math.random();
  }

  return Math.max(1, base - spread + Math.floor(unit * (spread * 2 + 1)));
}

export const ttlForKey = (baseSeconds: number, key: string) =>
  jitterTtl(baseSeconds, { salt: key });
