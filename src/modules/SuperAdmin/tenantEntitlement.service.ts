import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import {
  normalizeSubscriptionPlanFeatures,
  type SubscriptionPlanFeature,
} from "../../lib/utils/subscriptionPlanFeatures";

export const TENANT_RESOURCE_KEYS = [
  "staff",
  "clients",
  "monthlyBookings",
  "storageMb",
] as const;
export type TenantResourceKey = (typeof TENANT_RESOURCE_KEYS)[number];

export const TENANT_FEATURE_KEYS = [
  "website",
  "customDomain",
  "analytics",
  "bookingForms",
  "recurringBookings",
  "crmLeads",
  "reports",
  "automations",
] as const;
export type TenantFeatureKey = (typeof TENANT_FEATURE_KEYS)[number];

export type ResourceOverrideMode = "INHERIT" | "ADD" | "SET";
export type FeatureOverrideMode = "INHERIT" | "FORCE_ENABLED" | "FORCE_DISABLED";

export interface ResourceOverrideValue {
  mode: ResourceOverrideMode;
  value?: number;
}

export interface TenantEntitlementOverridePayload {
  resources?: Partial<Record<TenantResourceKey, ResourceOverrideValue>>;
  features?: Partial<Record<TenantFeatureKey, FeatureOverrideMode>>;
  expiresAt?: string | null;
  reason: string;
}

export interface EffectiveResourceLimits {
  staff: number | null;
  clients: number | null;
  monthlyBookings: number | null;
  storageMb: number | null;
}

const FEATURE_LABELS: Partial<Record<TenantFeatureKey, string>> = {
  customDomain: "Custom Domains",
  analytics: "Website Analytics History",
  bookingForms: "Online Booking",
  recurringBookings: "Recurring Bookings",
  crmLeads: "Leads Pipeline",
  reports: "Reports",
  automations: "Auto-Dispatch",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readResources = (value: unknown): Partial<Record<TenantResourceKey, ResourceOverrideValue>> => {
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

const readFeatures = (value: unknown): Partial<Record<TenantFeatureKey, FeatureOverrideMode>> => {
  if (!isRecord(value)) return {};
  const result: Partial<Record<TenantFeatureKey, FeatureOverrideMode>> = {};
  for (const key of TENANT_FEATURE_KEYS) {
    const mode = value[key];
    if (mode === "INHERIT" || mode === "FORCE_ENABLED" || mode === "FORCE_DISABLED") {
      result[key] = mode;
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
    resources: readResources(override.resources),
    features: readFeatures(override.features),
  };
};

const addBaseAndExtra = (base: number | null, extra: number): number | null =>
  base === null ? null : base + extra;

const applyNumericOverride = (base: number | null, override?: ResourceOverrideValue): number | null => {
  if (!override || override.mode === "INHERIT") return base;
  const value = override.value ?? 0;
  if (override.mode === "SET") return value;
  // ADD cannot make an already-unlimited plan finite.
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
        plan: {
          select: {
            maxStaff: true,
            maxClient: true,
            maxBookingsPerMonth: true,
          },
        },
      },
    }),
    prisma.tenantEntitlementOverride.findUnique({ where: { adminId } }),
  ]);

  const base: EffectiveResourceLimits = subscription
    ? {
        staff: addBaseAndExtra(subscription.plan.maxStaff, subscription.extraStaff),
        clients: addBaseAndExtra(subscription.plan.maxClient, subscription.extraClient),
        monthlyBookings: addBaseAndExtra(
          subscription.plan.maxBookingsPerMonth,
          subscription.extraBookingsPerMonth,
        ),
        // Storage has no canonical plan column yet. Null intentionally means
        // unlimited/unmetered until a plan-level storage limit is introduced.
        storageMb: null,
      }
    : { staff: null, clients: null, monthlyBookings: null, storageMb: null };

  if (!isOverrideActive(override)) return base;
  const resources = readResources(override?.resources);
  return {
    staff: applyNumericOverride(base.staff, resources.staff),
    clients: applyNumericOverride(base.clients, resources.clients),
    monthlyBookings: applyNumericOverride(base.monthlyBookings, resources.monthlyBookings),
    storageMb: applyNumericOverride(base.storageMb, resources.storageMb),
  };
};

export const getFeatureOverrideMode = (
  rawFeatures: unknown,
  key: TenantFeatureKey,
): FeatureOverrideMode => readFeatures(rawFeatures)[key] ?? "INHERIT";

export const applyTenantFeatureOverrides = (
  rawPlanFeatures: unknown,
  rawOverrides: unknown,
  active: boolean,
): SubscriptionPlanFeature[] => {
  const planFeatures = normalizeSubscriptionPlanFeatures(rawPlanFeatures ?? []);
  if (!active) return planFeatures;
  const overrides = readFeatures(rawOverrides);
  const byLabel = new Map(
    planFeatures.map((feature) => [feature.label.trim().toLowerCase(), { ...feature }]),
  );

  for (const [key, mode] of Object.entries(overrides) as [TenantFeatureKey, FeatureOverrideMode][]) {
    if (mode === "INHERIT" || key === "website") continue;
    const label = FEATURE_LABELS[key];
    if (!label) continue;
    const normalized = label.toLowerCase();
    const existing = byLabel.get(normalized) ?? { label, included: false };
    byLabel.set(normalized, {
      ...existing,
      included: mode === "FORCE_ENABLED",
    });
  }

  return Array.from(byLabel.values());
};

export const setTenantEntitlementOverride = async (
  adminId: string,
  actorUserId: string,
  payload: TenantEntitlementOverridePayload,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => {
  const resources = payload.resources ?? {};
  const features = payload.features ?? {};
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;

  const result = await db.tenantEntitlementOverride.upsert({
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

  return result;
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
