import { requestMemo, forgetRequestMemo } from "../../lib/monitoring/requestMemo";
import { randomUUID } from "node:crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";
import { CacheNamespaces, CacheTtl, ttlForKey } from "../../lib/cache/cachePolicy";
import { normalizeSubscriptionPlanFeatures } from "../../lib/utils/subscriptionPlanFeatures";
import {
  FEATURE_KEYS,
  type FeatureKey,
  featureParent,
} from "./featureCatalog";
import {
  isOverrideActive,
  readFeatureOverrides,
  readResourceOverrides,
  applyNumericResourceOverride,
  type EffectiveResourceLimits,
  type FeatureOverrideMode,
} from "../SuperAdmin/tenantEntitlement.service";

export type TenantAccessDeniedReason =
  | "ACTIVE"
  | "TENANT_SUSPENDED"
  | "TENANT_ARCHIVED"
  | "TENANT_PENDING_DELETION"
  | "OWNER_ACCOUNT_PENDING"
  | "OWNER_ACCOUNT_SUSPENDED"
  | "OWNER_ACCOUNT_DELETED"
  | "SUBSCRIPTION_MISSING"
  | "TRIAL_EXPIRED"
  | "SUBSCRIPTION_EXPIRED"
  | "PAYMENT_PENDING"
  | "SUBSCRIPTION_SUSPENDED";

export type PublicWebsiteDeniedReason = TenantAccessDeniedReason | "WEBSITE_UNPUBLISHED" | "FEATURE_NOT_INCLUDED";

export interface TenantAccessResolution {
  organizationId: string;
  /** Absolute authorization horizon; downstream caches must not extend it. */
  validUntil: string;
  /** Opaque invalidation epoch. Null means Redis was unavailable: do not cache. */
  generation: string | null;
  ownerUserId: string;
  platform: {
    status: string;
    suspendedAt: string | null;
    archivedAt: string | null;
    deletionStartedAt: string | null;
    deletionLastAttemptAt: string | null;
    deletionLastError: string | null;
    reason: string | null;
  };
  subscription: {
    id: string | null;
    status: string | null;
    isTrial: boolean;
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  website: {
    status: string | null;
    published: boolean;
    publicAccessAllowed: boolean;
    deniedReason: PublicWebsiteDeniedReason;
  };
  access: {
    dashboardAllowed: boolean;
    publicWebsiteAllowed: boolean;
    publicWritesAllowed: boolean;
    backgroundJobsAllowed: boolean;
    recoveryAllowed: boolean;
    deniedReason: TenantAccessDeniedReason;
  };
  plan: {
    id: string | null;
    name: string | null;
    pricingId: string | null;
    features: ReturnType<typeof normalizeSubscriptionPlanFeatures>;
  };
  baseEntitlements: Record<FeatureKey, boolean>;
  paidExtras: {
    staff: number;
    clients: number;
    monthlyBookings: number;
    storageMb: number;
  };
  tenantOverrides: {
    active: boolean;
    expiresAt: string | null;
    reason: string | null;
    features: Partial<Record<FeatureKey, FeatureOverrideMode>>;
    resources: ReturnType<typeof readResourceOverrides>;
  };
  effectiveEntitlements: Record<FeatureKey, boolean>;
  resourceLimits: {
    base: EffectiveResourceLimits;
    afterPaidExtras: EffectiveResourceLimits;
    effective: EffectiveResourceLimits;
  };
}

// A new namespace rejects legacy entries without an epoch/deadline. Epochs do
// not expire independently of values; random tokens also prevent an ABA race
// after eviction, FLUSHDB or Redis failover.
const accessCacheKey = (organizationId: string) => `${CacheNamespaces.tenantAccess(organizationId)}:v2`;
const generationKey = (organizationId: string) => `${accessCacheKey(organizationId)}:generation`;

const getGeneration = async (organizationId: string): Promise<string | null> => {
  try {
    const key = generationKey(organizationId);
    const existing = await redis.get(key);
    if (existing) return existing;
    const token = randomUUID();
    if (await redis.set(key, token, "NX") === "OK") return token;
    return await redis.get(key);
  } catch {
    return null;
  }
};

const isCurrentGeneration = async (organizationId: string, generation: string | null): Promise<boolean> =>
  Boolean(generation && await getGeneration(organizationId) === generation);

const readCached = async (organizationId: string, generation: string | null): Promise<TenantAccessResolution | null> => {
  if (!generation) return null;
  try {
    const raw = await redis.get(accessCacheKey(organizationId));
    if (!raw) return null;
    const value = JSON.parse(raw) as TenantAccessResolution;
    if (value.organizationId !== organizationId || value.generation !== generation ||
        !Number.isFinite(Date.parse(value.validUntil)) || Date.parse(value.validUntil) <= Date.now()) return null;
    return await isCurrentGeneration(organizationId, generation) ? value : null;
  } catch {
    // A corrupt entry is a miss, not an asynchronous DEL of a newer writer.
    return null;
  }
};

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

/** Pure feature override rule used by the resolver and regression matrix. */
export const applyFeatureOverride = (baseIncluded: boolean, mode: FeatureOverrideMode = "INHERIT"): boolean => {
  if (mode === "FORCE_ENABLED") return true;
  if (mode === "FORCE_DISABLED") return false;
  return baseIncluded;
};

export const evaluateTenantAccess = (input: {
  lifecycleStatus: string;
  ownerStatus: string;
  subscriptionStatus?: string | null;
  isTrial?: boolean;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
  now?: Date;
}): { deniedReason: TenantAccessDeniedReason; dashboardAllowed: boolean; recoveryAllowed: boolean } => {
  const now = input.now ?? new Date();
  let deniedReason: TenantAccessDeniedReason = "ACTIVE";

  if (input.lifecycleStatus === "PENDING_DELETION") deniedReason = "TENANT_PENDING_DELETION";
  else if (input.lifecycleStatus === "ARCHIVED") deniedReason = "TENANT_ARCHIVED";
  else if (input.lifecycleStatus === "SUSPENDED") deniedReason = "TENANT_SUSPENDED";
  else if (input.ownerStatus === "DELETED") deniedReason = "OWNER_ACCOUNT_DELETED";
  else if (input.ownerStatus === "SUSPENDED") deniedReason = "OWNER_ACCOUNT_SUSPENDED";
  else if (input.ownerStatus === "PENDING") deniedReason = "OWNER_ACCOUNT_PENDING";
  else if (!input.subscriptionStatus) deniedReason = "SUBSCRIPTION_MISSING";
  else if (input.subscriptionStatus === "SUSPENDED") deniedReason = "SUBSCRIPTION_SUSPENDED";
  else if (input.subscriptionStatus === "PENDING_PAYMENT") deniedReason = "PAYMENT_PENDING";
  else if (input.subscriptionStatus === "EXPIRED" || input.subscriptionStatus === "CANCELLED") deniedReason = "SUBSCRIPTION_EXPIRED";
  else if (input.isTrial && input.trialEndsAt && input.trialEndsAt <= now) deniedReason = "TRIAL_EXPIRED";
  else if (!input.isTrial && input.currentPeriodEnd && input.currentPeriodEnd <= now) deniedReason = "SUBSCRIPTION_EXPIRED";

  const dashboardAllowed = deniedReason === "ACTIVE";
  const recoveryAllowed = !["TENANT_ARCHIVED", "TENANT_PENDING_DELETION", "TENANT_SUSPENDED", "OWNER_ACCOUNT_DELETED", "OWNER_ACCOUNT_SUSPENDED"].includes(deniedReason);
  return { deniedReason, dashboardAllowed, recoveryAllowed };
};

function buildFeatureState(
  rawPlanFeatures: unknown,
  rawOverrides: unknown,
  overrideActive: boolean,
): { base: Record<FeatureKey, boolean>; effective: Record<FeatureKey, boolean> } {
  const normalized = normalizeSubscriptionPlanFeatures(rawPlanFeatures);
  const explicit = new Map<FeatureKey, boolean>();
  for (const feature of normalized) {
    if (feature.key) explicit.set(feature.key, feature.included);
  }

  // Website and Online Booking are core product invariants for an otherwise
  // active subscription. Existing STARTER rows may contain historical false
  // values, so these defaults deliberately win over stale plan JSON.
  explicit.set("website", true);
  explicit.set("online_booking", true);

  const base = {} as Record<FeatureKey, boolean>;
  const resolveBase = (key: FeatureKey, stack = new Set<FeatureKey>()): boolean => {
    if (Object.prototype.hasOwnProperty.call(base, key)) return base[key];
    if (stack.has(key)) return false;
    const next = new Set(stack); next.add(key);
    if (explicit.has(key)) return (base[key] = explicit.get(key) === true);
    const parent = featureParent(key);
    return (base[key] = parent ? resolveBase(parent, next) : false);
  };
  FEATURE_KEYS.forEach((key) => resolveBase(key));

  const overrides = overrideActive ? readFeatureOverrides(rawOverrides) : {};
  const effective = {} as Record<FeatureKey, boolean>;
  const resolveEffective = (key: FeatureKey, stack = new Set<FeatureKey>()): boolean => {
    if (Object.prototype.hasOwnProperty.call(effective, key)) return effective[key];
    if (stack.has(key)) return false;
    const mode = overrides[key] ?? "INHERIT";
    if (mode !== "INHERIT") return (effective[key] = applyFeatureOverride(base[key], mode));
    if (explicit.has(key)) return (effective[key] = base[key]);
    const parent = featureParent(key);
    if (parent) {
      const next = new Set(stack); next.add(key);
      return (effective[key] = resolveEffective(parent, next));
    }
    return (effective[key] = base[key]);
  };
  FEATURE_KEYS.forEach((key) => resolveEffective(key));
  return { base, effective };
}

function addLimit(base: number | null, extra: number): number | null {
  return base === null ? null : base + Math.max(0, extra);
}

const loadTenantAccess = async (organizationId: string, generation: string | null): Promise<TenantAccessResolution> => {
  const key = accessCacheKey(organizationId);
  const tenant = await prisma.adminProfile.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      userId: true,
      lifecycleStatus: true,
      suspendedAt: true,
      suspendedReason: true,
      archivedAt: true,
      archivedReason: true,
      deletionStartedAt: true,
      deletionLastAttemptAt: true,
      deletionLastError: true,
      deletionReason: true,
      user: { select: { status: true } },
      businessWebsite: { select: { status: true } },
      entitlementOverride: { select: { resources: true, features: true, expiresAt: true, reason: true } },
      subscription: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          isTrial: true,
          trialEndsAt: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          extraStaff: true,
          extraClient: true,
          extraBookingsPerMonth: true,
          plan: { select: { id: true, maxStaff: true, maxClient: true, maxBookingsPerMonth: true } },
          subscriptionPlan: { select: { id: true, name: true, features: true } },
        },
      },
    },
  });
  if (!tenant) throw new AppError(status.NOT_FOUND, "Organization not found.", { code: "ORGANIZATION_NOT_FOUND", retryable: false });

  const subscription = tenant.subscription[0] ?? null;
  const evaluatedAt = Date.now();
  const overrideActive = isOverrideActive(tenant.entitlementOverride, new Date(evaluatedAt));
  const features = buildFeatureState(subscription?.subscriptionPlan?.features ?? [], tenant.entitlementOverride?.features, overrideActive);
  const accessState = evaluateTenantAccess({
    now: new Date(evaluatedAt),
    lifecycleStatus: tenant.lifecycleStatus,
    ownerStatus: tenant.user.status,
    subscriptionStatus: subscription?.status ?? null,
    isTrial: subscription?.isTrial ?? false,
    trialEndsAt: subscription?.trialEndsAt ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
  });

  const base: EffectiveResourceLimits = subscription ? {
    staff: subscription.plan.maxStaff,
    clients: subscription.plan.maxClient,
    monthlyBookings: subscription.plan.maxBookingsPerMonth,
    storageMb: null,
  } : { staff: null, clients: null, monthlyBookings: null, storageMb: null };
  const paidExtras = {
    staff: subscription?.extraStaff ?? 0,
    clients: subscription?.extraClient ?? 0,
    monthlyBookings: subscription?.extraBookingsPerMonth ?? 0,
    storageMb: 0,
  };
  const afterPaidExtras: EffectiveResourceLimits = {
    staff: addLimit(base.staff, paidExtras.staff),
    clients: addLimit(base.clients, paidExtras.clients),
    monthlyBookings: addLimit(base.monthlyBookings, paidExtras.monthlyBookings),
    storageMb: addLimit(base.storageMb, paidExtras.storageMb),
  };
  const resourceOverrides = overrideActive ? readResourceOverrides(tenant.entitlementOverride?.resources) : {};
  const effectiveResources: EffectiveResourceLimits = {
    staff: applyNumericResourceOverride(afterPaidExtras.staff, resourceOverrides.staff),
    clients: applyNumericResourceOverride(afterPaidExtras.clients, resourceOverrides.clients),
    monthlyBookings: applyNumericResourceOverride(afterPaidExtras.monthlyBookings, resourceOverrides.monthlyBookings),
    storageMb: applyNumericResourceOverride(afterPaidExtras.storageMb, resourceOverrides.storageMb),
  };

  const websitePublished = tenant.businessWebsite?.status === "PUBLISHED";
  let websiteDeniedReason: PublicWebsiteDeniedReason = accessState.deniedReason;
  if (accessState.dashboardAllowed && !websitePublished) websiteDeniedReason = "WEBSITE_UNPUBLISHED";
  else if (accessState.dashboardAllowed && !features.effective.website) websiteDeniedReason = "FEATURE_NOT_INCLUDED";
  const publicWebsiteAllowed = accessState.dashboardAllowed && websitePublished && features.effective.website;

  const expiryCandidates = [
    evaluatedAt + ttlForKey(CacheTtl.tenantAccess, key) * 1000,
    tenant.entitlementOverride?.expiresAt?.getTime(),
    subscription?.isTrial ? subscription.trialEndsAt?.getTime() : subscription?.currentPeriodEnd?.getTime(),
  ].filter((value): value is number => typeof value === "number" && value > evaluatedAt);

  const resolution: TenantAccessResolution = {
    validUntil: new Date(Math.min(...expiryCandidates)).toISOString(),
    generation,
    organizationId: tenant.id,
    ownerUserId: tenant.userId,
    platform: {
      status: tenant.lifecycleStatus,
      suspendedAt: iso(tenant.suspendedAt),
      archivedAt: iso(tenant.archivedAt),
      deletionStartedAt: iso(tenant.deletionStartedAt),
      deletionLastAttemptAt: iso(tenant.deletionLastAttemptAt),
      deletionLastError: tenant.deletionLastError ?? null,
      reason: tenant.deletionReason ?? tenant.archivedReason ?? tenant.suspendedReason ?? null,
    },
    subscription: {
      id: subscription?.id ?? null,
      status: subscription?.status ?? null,
      isTrial: subscription?.isTrial ?? false,
      trialEndsAt: iso(subscription?.trialEndsAt),
      currentPeriodStart: iso(subscription?.currentPeriodStart),
      currentPeriodEnd: iso(subscription?.currentPeriodEnd),
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    },
    website: {
      status: tenant.businessWebsite?.status ?? null,
      published: websitePublished,
      publicAccessAllowed: publicWebsiteAllowed,
      deniedReason: websiteDeniedReason,
    },
    access: {
      dashboardAllowed: accessState.dashboardAllowed,
      publicWebsiteAllowed,
      publicWritesAllowed: accessState.dashboardAllowed,
      backgroundJobsAllowed: accessState.dashboardAllowed,
      recoveryAllowed: accessState.recoveryAllowed,
      deniedReason: accessState.deniedReason,
    },
    plan: {
      id: subscription?.subscriptionPlan?.id ?? null,
      name: subscription?.subscriptionPlan?.name ?? null,
      pricingId: subscription?.plan?.id ?? null,
      features: normalizeSubscriptionPlanFeatures(subscription?.subscriptionPlan?.features ?? []),
    },
    baseEntitlements: features.base,
    paidExtras,
    tenantOverrides: {
      active: overrideActive,
      expiresAt: iso(tenant.entitlementOverride?.expiresAt),
      reason: tenant.entitlementOverride?.reason ?? null,
      features: overrideActive ? readFeatureOverrides(tenant.entitlementOverride?.features) : {},
      resources: resourceOverrides,
    },
    effectiveEntitlements: features.effective,
    resourceLimits: { base, afterPaidExtras, effective: effectiveResources },
  };

  return resolution;
};

async function resolveUncachedTenantAccess(organizationId: string): Promise<TenantAccessResolution> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Capture the epoch BEFORE starting SQL, never after the result arrives.
    const generation = await getGeneration(organizationId);
    const cached = await readCached(organizationId, generation);
    if (cached) return cached;
    const loaded = await loadTenantAccess(organizationId, generation);
    const ttlMs = Math.floor(Date.parse(loaded.validUntil) - Date.now());
    if (ttlMs <= 0) continue;
    if (!generation) return loaded; // SQL-only degradation; no unsafe cache fill.
    try {
      const stored = await redis.eval(
        `-- access:cas
         if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
         redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
         return 1`,
        2, accessCacheKey(organizationId), generationKey(organizationId),
        generation, JSON.stringify(loaded), String(ttlMs),
      );
      if (Number(stored) === 1) return loaded;
      // A lifecycle change raced the query. Retry from SQL under the new epoch.
    } catch {
      // Do not hand a potentially pre-invalidation result to the route cache.
      return loadTenantAccess(organizationId, null);
    }
  }
  throw new AppError(status.SERVICE_UNAVAILABLE, "Organization access is changing; retry the request.", {
    code: "TENANT_ACCESS_CHANGING", retryable: true,
  });
}

export function resolveTenantAccess(organizationId: string, options: { fresh?: boolean } = {}): Promise<TenantAccessResolution> {
  const key = `tenant-access:${organizationId}`;
  if (options.fresh) forgetRequestMemo(key);
  return requestMemo(key, () => resolveUncachedTenantAccess(organizationId), value =>
    value.organizationId === organizationId && Number.isFinite(Date.parse(value.validUntil)) && Date.parse(value.validUntil) > Date.now());
}

export async function invalidateTenantAccess(organizationId: string): Promise<boolean> {
  forgetRequestMemo(`tenant-access:${organizationId}`);
  try {
    const result = await redis.eval(
      `-- access:invalidate
       redis.call('SET', KEYS[2], ARGV[1])
       redis.call('DEL', KEYS[1])
       return 1`,
      2, accessCacheKey(organizationId), generationKey(organizationId), randomUUID(),
    );
    return Number(result) === 1;
  } catch {
    return false;
  }
}

export const tenantFeatureAllowed = async (organizationId: string, key: FeatureKey) =>
  (await resolveTenantAccess(organizationId)).effectiveEntitlements[key] === true;

export const TenantAccessResolver = {
  resolve: resolveTenantAccess,
  invalidate: invalidateTenantAccess,
  featureAllowed: tenantFeatureAllowed,
  isCurrentGeneration,
};
