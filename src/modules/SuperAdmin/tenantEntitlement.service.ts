import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import {
  normalizeSubscriptionPlanFeatures,
  type SubscriptionPlanFeature,
} from "../../lib/utils/subscriptionPlanFeatures";
import {
  FEATURE_KEYS,
  FEATURE_CATALOG,
  LEGACY_OVERRIDE_KEY_MAP,
  isFeatureKey,
  resolveFeatureKey,
  type FeatureKey,
} from "../Entitlement/featureCatalog";

export const TENANT_RESOURCE_KEYS = [
  "staff",
  "clients",
  "monthlyBookings",
  "storageMb",
] as const;
export type TenantResourceKey = (typeof TENANT_RESOURCE_KEYS)[number];

/** Canonical persisted override keys. */
export const TENANT_FEATURE_KEYS = FEATURE_KEYS;
export type TenantFeatureKey = FeatureKey;

export type ResourceOverrideMode = "INHERIT" | "ADD" | "SET";
export type FeatureOverrideMode = "INHERIT" | "FORCE_ENABLED" | "FORCE_DISABLED";

export interface ResourceOverrideValue {
  mode: ResourceOverrideMode;
  value?: number;
}

export interface TenantEntitlementOverridePayload {
  resources?: Partial<Record<TenantResourceKey, ResourceOverrideValue>>;
  features?: Partial<Record<TenantFeatureKey, FeatureOverrideMode>> & Record<string, FeatureOverrideMode | undefined>;
  expiresAt?: string | null;
  reason: string;
}

export interface EffectiveResourceLimits {
  staff: number | null;
  clients: number | null;
  monthlyBookings: number | null;
  storageMb: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const readResourceOverrides = (value: unknown): Partial<Record<TenantResourceKey, ResourceOverrideValue>> => {
  if (!isRecord(value)) return {};
  const result: Partial<Record<TenantResourceKey, ResourceOverrideValue>> = {};
  for (const key of TENANT_RESOURCE_KEYS) {
    const candidate = value[key];
    if (!isRecord(candidate)) continue;
    const mode = candidate.mode;
    const numeric = candidate.value;
    if (mode === "INHERIT") result[key] = { mode };
    if ((mode === "ADD" || mode === "SET") && typeof numeric === "number" && Number.isInteger(numeric) && numeric >= 0) {
      result[key] = { mode, value: numeric };
    }
  }
  return result;
};

/**
 * Reads canonical keys and the previous camelCase keys. Canonical values win
 * when both are present, enabling a no-downtime rolling deployment.
 */
export const readFeatureOverrides = (value: unknown): Partial<Record<TenantFeatureKey, FeatureOverrideMode>> => {
  if (!isRecord(value)) return {};
  const result: Partial<Record<TenantFeatureKey, FeatureOverrideMode>> = {};
  const accept = (key: FeatureKey, candidate: unknown) => {
    if (candidate === "INHERIT" || candidate === "FORCE_ENABLED" || candidate === "FORCE_DISABLED") {
      result[key] = candidate;
    }
  };

  for (const [legacyKey, canonical] of Object.entries(LEGACY_OVERRIDE_KEY_MAP)) {
    accept(canonical, value[legacyKey]);
  }
  for (const key of FEATURE_KEYS) accept(key, value[key]);
  return result;
};

const canonicalizeFeaturePayload = (value: unknown): Partial<Record<FeatureKey, FeatureOverrideMode>> => {
  if (!isRecord(value)) return {};
  const result: Partial<Record<FeatureKey, FeatureOverrideMode>> = {};
  for (const [rawKey, rawMode] of Object.entries(value)) {
    const canonical = isFeatureKey(rawKey)
      ? rawKey
      : (LEGACY_OVERRIDE_KEY_MAP as Record<string, FeatureKey>)[rawKey] ?? resolveFeatureKey(rawKey);
    if (!canonical) continue;
    if (rawMode === "INHERIT" || rawMode === "FORCE_ENABLED" || rawMode === "FORCE_DISABLED") {
      result[canonical] = rawMode;
    }
  }
  return result;
};

export const isOverrideActive = (override: { expiresAt: Date | null } | null | undefined, now = new Date()) =>
  Boolean(override && (!override.expiresAt || override.expiresAt > now));

export const getTenantEntitlementOverride = async (adminId: string) => {
  const override = await prisma.tenantEntitlementOverride.findUnique({
    where: { adminId },
  });
  if (!override) return null;
  return {
    ...override,
    active: isOverrideActive(override),
    resources: readResourceOverrides(override.resources),
    features: readFeatureOverrides(override.features),
  };
};

const addBaseAndExtra = (base: number | null, extra: number): number | null =>
  base === null ? null : base + extra;

export const applyNumericResourceOverride = (base: number | null, override?: ResourceOverrideValue): number | null => {
  if (!override || override.mode === "INHERIT") return base;
  const value = override.value ?? 0;
  if (override.mode === "SET") return value;
  if (base === null) return null;
  return base + value;
};

export const getEffectiveResourceLimits = async (adminId: string): Promise<EffectiveResourceLimits> => {
  const [subscription, override] = await Promise.all([
    prisma.subscription.findFirst({
      where: { adminId },
      orderBy: { createdAt: "desc" },
      select: {
        extraStaff: true,
        extraClient: true,
        extraBookingsPerMonth: true,
        plan: { select: { maxStaff: true, maxClient: true, maxBookingsPerMonth: true } },
      },
    }),
    prisma.tenantEntitlementOverride.findUnique({ where: { adminId } }),
  ]);

  const base: EffectiveResourceLimits = subscription
    ? {
        staff: addBaseAndExtra(subscription.plan.maxStaff, subscription.extraStaff),
        clients: addBaseAndExtra(subscription.plan.maxClient, subscription.extraClient),
        monthlyBookings: addBaseAndExtra(subscription.plan.maxBookingsPerMonth, subscription.extraBookingsPerMonth),
        storageMb: null,
      }
    : { staff: null, clients: null, monthlyBookings: null, storageMb: null };

  if (!isOverrideActive(override)) return base;
  const resources = readResourceOverrides(override?.resources);
  return {
    staff: applyNumericResourceOverride(base.staff, resources.staff),
    clients: applyNumericResourceOverride(base.clients, resources.clients),
    monthlyBookings: applyNumericResourceOverride(base.monthlyBookings, resources.monthlyBookings),
    storageMb: applyNumericResourceOverride(base.storageMb, resources.storageMb),
  };
};

export const getFeatureOverrideMode = (
  rawFeatures: unknown,
  key: TenantFeatureKey,
): FeatureOverrideMode => readFeatureOverrides(rawFeatures)[key] ?? "INHERIT";

/**
 * Compatibility helper for code paths that still consume a feature array.
 * Authorization itself is handled by TenantAccessResolver using stable keys.
 */
export const applyTenantFeatureOverrides = (
  rawPlanFeatures: unknown,
  rawOverrides: unknown,
  active: boolean,
): SubscriptionPlanFeature[] => {
  const planFeatures = normalizeSubscriptionPlanFeatures(rawPlanFeatures ?? []);
  if (!active) return planFeatures;
  const overrides = readFeatureOverrides(rawOverrides);
  const byKey = new Map<string, SubscriptionPlanFeature>();
  for (const feature of planFeatures) {
    byKey.set(feature.key ? `key:${feature.key}` : `label:${feature.label.toLowerCase()}`, { ...feature });
  }

  for (const [key, mode] of Object.entries(overrides) as [FeatureKey, FeatureOverrideMode][]) {
    if (mode === "INHERIT") continue;
    const definition = FEATURE_CATALOG[key];
    const mapKey = `key:${key}`;
    const existing = byKey.get(mapKey) ?? { key, label: definition.label, included: false };
    byKey.set(mapKey, { ...existing, key, label: existing.label || definition.label, included: mode === "FORCE_ENABLED" });
  }
  return Array.from(byKey.values());
};

export const setTenantEntitlementOverride = async (
  adminId: string,
  actorUserId: string,
  payload: TenantEntitlementOverridePayload,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => {
  const resources = readResourceOverrides(payload.resources ?? {});
  const features = canonicalizeFeaturePayload(payload.features ?? {});
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;

  return db.tenantEntitlementOverride.upsert({
    where: { adminId },
    create: {
      adminId,
      resources: resources as Prisma.InputJsonValue,
      features: features as Prisma.InputJsonValue,
      expiresAt,
      reason: payload.reason.trim(),
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    },
    update: {
      resources: resources as Prisma.InputJsonValue,
      features: features as Prisma.InputJsonValue,
      expiresAt,
      reason: payload.reason.trim(),
      updatedByUserId: actorUserId,
    },
  });
};

export const revokeTenantEntitlementOverride = async (
  adminId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => {
  const result = await db.tenantEntitlementOverride.deleteMany({ where: { adminId } });
  return { revoked: result.count > 0 };
};

export const TenantEntitlementService = {
  getTenantEntitlementOverride,
  getEffectiveResourceLimits,
  getFeatureOverrideMode,
  applyTenantFeatureOverrides,
  setTenantEntitlementOverride,
  revokeTenantEntitlementOverride,
};
