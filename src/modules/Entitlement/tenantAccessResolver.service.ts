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
  /** Absolute authorization deadline, propagated to every dependent cache. */
  cache?: { generation: string; validUntil: string };
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

// A new namespace rejects legacy, unversioned access decisions during rollout.
const accessCacheKey = (organizationId: string) => `tenant-access:v2:${organizationId}`;
export const tenantAccessGenerationKey = (organizationId: string) => `tenant-access:generation:${organizationId}`;

export const tenantAccessValidUntil = (access: TenantAccessResolution): number => {
  const deadline = Date.parse(access.cache?.validUntil ?? "");
  // An unversioned/test/legacy decision must not be promoted into a routing cache.
  return Number.isFinite(deadline) ? deadline : 0;
};

const getGeneration = async (organizationId: string): Promise<string | null> => {
  try { return (await redis.get(tenantAccessGenerationKey(organizationId))) ?? "0"; }
  catch { return null; }
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

async function loadTenantAccess(organizationId: string): Promise<TenantAccessResolution> {
  const key = accessCacheKey(organizationId);
  const adminProfileDelegate = prisma.adminProfile;
  if (!adminProfileDelegate?.findUnique) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Tenant access storage is not available.", {
      code: "TENANT_ACCESS_STORAGE_UNAVAILABLE", retryable: true,
    });
  }
  const tenant = await adminProfileDelegate.findUnique({
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

  const now = new Date();
  const subscription = tenant.subscription[0] ?? null;
  const overrideActive = isOverrideActive(tenant.entitlementOverride, now);
  const features = buildFeatureState(subscription?.subscriptionPlan?.features ?? [], tenant.entitlementOverride?.features, overrideActive);
  const accessState = evaluateTenantAccess({
    now,
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

  const resolution: TenantAccessResolution = {
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

  // Never round an expiry up to the next second. The absolute deadline is also
  // checked on reads, so Redis/network delay and route jitter cannot extend it.
  const deadlines = [now.getTime() + ttlForKey(CacheTtl.tenantAccess, key) * 1000];
  for (const date of [
    tenant.entitlementOverride?.expiresAt,
    subscription?.isTrial ? subscription.trialEndsAt : subscription?.currentPeriodEnd,
  ]) {
    if (date && date.getTime() > now.getTime()) deadlines.push(date.getTime());
  }
  resolution.cache = { generation: "0", validUntil: new Date(Math.min(...deadlines)).toISOString() };
  return resolution;
}

export async function resolveTenantAccess(
  organizationId: string,
  options: { fresh?: boolean } = {},
): Promise<TenantAccessResolution> {
  const key = accessCacheKey(organizationId);
  if (!options.fresh) {
    try {
      // One atomic read pairs a cached decision with its current generation.
      const pair = await redis.eval(
        "return {redis.call('GET', KEYS[1]), redis.call('GET', KEYS[2]) or '0'}",
        2, key, tenantAccessGenerationKey(organizationId),
      ) as [string | null, string];
      if (pair?.[0]) {
        const cached = JSON.parse(pair[0]) as TenantAccessResolution;
        if (cached.organizationId === organizationId && cached.cache?.generation === pair[1] &&
            tenantAccessValidUntil(cached) > Date.now()) return cached;
      }
    } catch { /* No cache availability must ever grant authorization. */ }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generation = await getGeneration(organizationId);
    const resolution = await loadTenantAccess(organizationId);
    if (generation === null) return resolution;
    resolution.cache!.generation = generation;
    const ttlMs = Math.floor(tenantAccessValidUntil(resolution) - Date.now());
    if (ttlMs <= 0) continue;
    try {
      const stored = await redis.eval(
        `local current = redis.call('GET', KEYS[2]) or '0'
         if current ~= ARGV[1] then return 0 end
         redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
         return 1`,
        2, key, tenantAccessGenerationKey(organizationId), generation,
        JSON.stringify(resolution), String(ttlMs),
      );
      if (Number(stored) === 1) return resolution;
      // Invalidation won the race. Discard the old result, not just its write.
    } catch { return resolution; }
  }
  throw new AppError(status.SERVICE_UNAVAILABLE, "Tenant access changed while being resolved. Retry the request.", {
    code: "TENANT_ACCESS_CHANGED", retryable: true,
  });
}

export async function invalidateTenantAccess(organizationId: string): Promise<boolean> {
  try {
    const result = await redis.eval(
      `redis.call('INCR', KEYS[2])
       redis.call('DEL', KEYS[1], KEYS[3])
       return 1`,
      3, accessCacheKey(organizationId), tenantAccessGenerationKey(organizationId),
      CacheNamespaces.tenantAccess(organizationId),
    );
    return Number(result) === 1;
  } catch { return false; }
}

export const tenantFeatureAllowed = async (organizationId: string, key: FeatureKey) =>
  (await resolveTenantAccess(organizationId)).effectiveEntitlements[key] === true;

export const TenantAccessResolver = {
  resolve: resolveTenantAccess,
  invalidate: invalidateTenantAccess,
  featureAllowed: tenantFeatureAllowed,
};
