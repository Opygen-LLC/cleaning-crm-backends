import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { SubscriptionStatus } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import redis from "../../config/redis";
import { CacheNamespaces, CacheTtl, ttlForKey } from "../../lib/cache/cachePolicy";
import { cacheRuntimeSubscriptionForAdmin, getRuntimeSubscriptionForAdmin } from "../../lib/cache/authRuntimeCache";
import { normalizeSubscriptionPlanFeatures, type SubscriptionPlanFeature } from "../../lib/utils/subscriptionPlanFeatures";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type { WebsiteTemplateDefinition } from "./templateRegistry";
import { applyTenantFeatureOverrides, getTenantEntitlementOverride } from "../SuperAdmin/tenantEntitlement.service";

export const MAX_WEBSITE_ANALYTICS_HISTORY_DAYS = 730 as const;

export const WEBSITE_ENTITLEMENT_FEATURES = Object.freeze({
  CUSTOM_DOMAINS: "Custom Domains",
  PREMIUM_TEMPLATES: "Premium Website Templates",
  ANALYTICS_HISTORY: "Website Analytics History",
  ADVANCED_SEO: "Advanced Website SEO",
});

export interface WebsiteEntitlements {
  planName: string;
  basicWebsite: true;
  freeSubdomain: true;
  onlineBooking: true;
  customDomains: boolean;
  customDomainLimit: number;
  premiumTemplates: boolean;
  analyticsHistoryDays: number;
  advancedSeo: boolean;
}

type SubscriptionEntitlementSource = {
  status?: string | null;
  isTrial?: boolean | null;
  trialEndsAt?: Date | string | null;
  currentPeriodEnd?: Date | string | null;
  subscriptionPlan?: { name?: string | null; features?: unknown } | null;
} | null | undefined;

const normalizeKey = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const featureByLabel = (features: SubscriptionPlanFeature[], label: string) => {
  const key = normalizeKey(label);
  return features.find((feature) => normalizeKey(feature.label) === key) ?? null;
};

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const match = value.match(/\d+/);
  if (!match) return /unlimited/i.test(value) ? Number.MAX_SAFE_INTEGER : fallback;
  const parsed = Number(match[0]);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const planDefaults = (planNameRaw: string | null | undefined): Omit<WebsiteEntitlements, "planName" | "basicWebsite" | "freeSubdomain" | "onlineBooking"> => {
  const planName = String(planNameRaw ?? "STARTER").toUpperCase();
  switch (planName) {
    case "CUSTOM":
      return { customDomains: true, customDomainLimit: 5, premiumTemplates: true, analyticsHistoryDays: 730, advancedSeo: true };
    case "PRO":
      return { customDomains: true, customDomainLimit: 3, premiumTemplates: true, analyticsHistoryDays: 365, advancedSeo: true };
    case "GROWTH":
      return { customDomains: true, customDomainLimit: 1, premiumTemplates: true, analyticsHistoryDays: 90, advancedSeo: true };
    default:
      return { customDomains: false, customDomainLimit: 0, premiumTemplates: false, analyticsHistoryDays: 30, advancedSeo: false };
  }
};

const hasActivePaidOrTrialAccess = (source: SubscriptionEntitlementSource): boolean => {
  if (!source || source.status !== SubscriptionStatus.ACTIVE) return false;
  const now = Date.now();
  if (source.isTrial && source.trialEndsAt && new Date(source.trialEndsAt).getTime() < now) return false;
  if (!source.isTrial && source.currentPeriodEnd && new Date(source.currentPeriodEnd).getTime() < now) return false;
  return true;
};

export const deriveWebsiteEntitlements = (source: SubscriptionEntitlementSource): WebsiteEntitlements => {
  const active = hasActivePaidOrTrialAccess(source);
  const planName = active ? String(source?.subscriptionPlan?.name ?? "STARTER").toUpperCase() : "STARTER";
  const defaults = planDefaults(planName);
  const features = active ? normalizeSubscriptionPlanFeatures(source?.subscriptionPlan?.features ?? []) : [];

  const customDomainsFeature = featureByLabel(features, WEBSITE_ENTITLEMENT_FEATURES.CUSTOM_DOMAINS);
  const premiumFeature = featureByLabel(features, WEBSITE_ENTITLEMENT_FEATURES.PREMIUM_TEMPLATES);
  const analyticsFeature = featureByLabel(features, WEBSITE_ENTITLEMENT_FEATURES.ANALYTICS_HISTORY);
  const advancedSeoFeature = featureByLabel(features, WEBSITE_ENTITLEMENT_FEATURES.ADVANCED_SEO);

  const customDomains = customDomainsFeature ? customDomainsFeature.included : defaults.customDomains;
  const customDomainLimit = customDomains
    ? parsePositiveInteger(customDomainsFeature?.limit, defaults.customDomainLimit)
    : 0;

  const analyticsHistoryDays = analyticsFeature
    ? analyticsFeature.included
      ? parsePositiveInteger(analyticsFeature.limit, defaults.analyticsHistoryDays)
      : 30
    : defaults.analyticsHistoryDays;

  return {
    planName,
    // Product invariant: every account tier keeps the website acquisition core.
    basicWebsite: true,
    freeSubdomain: true,
    onlineBooking: true,
    customDomains,
    customDomainLimit,
    premiumTemplates: premiumFeature ? premiumFeature.included : defaults.premiumTemplates,
    analyticsHistoryDays: Math.min(
      MAX_WEBSITE_ANALYTICS_HISTORY_DAYS,
      Math.max(30, analyticsHistoryDays),
    ),
    advancedSeo: advancedSeoFeature ? advancedSeoFeature.included : defaults.advancedSeo,
  };
};

export const websiteEntitlementSubscriptionSelect = {
  status: true,
  isTrial: true,
  trialEndsAt: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  subscriptionPlan: { select: { name: true, features: true } },
} as const;

const getForAdminId = async (adminId: string): Promise<WebsiteEntitlements> => {
  const key = CacheNamespaces.entitlements(adminId);
  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as WebsiteEntitlements;
    } catch {
      void redis.del(key).catch(() => {});
    }
  }

  // checkSubscription primes subscription:{adminId} as part of TenantContext.
  // Reuse that snapshot so Website Studio/domain/template gates do not perform
  // another subscription join on the same authenticated request.
  const runtimeSubscription = await getRuntimeSubscriptionForAdmin(adminId);
  let source: SubscriptionEntitlementSource;
  if (runtimeSubscription) {
    source = {
      status: runtimeSubscription.status,
      isTrial: runtimeSubscription.isTrial,
      trialEndsAt: runtimeSubscription.trialEndsAt,
      currentPeriodEnd: runtimeSubscription.currentPeriodEnd,
      subscriptionPlan: {
        name: runtimeSubscription.planName,
        features: runtimeSubscription.features,
      },
    };
  } else {
    const subscription = await prisma.subscription.findFirst({
      where: { adminId },
      select: websiteEntitlementSubscriptionSelect,
      orderBy: { createdAt: "desc" },
    });
    source = subscription;
    if (subscription) {
      void cacheRuntimeSubscriptionForAdmin(adminId, {
        status: subscription.status,
        planId: null,
        planName: subscription.subscriptionPlan?.name ?? null,
        isTrial: subscription.isTrial,
        trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        features: subscription.subscriptionPlan?.features ?? [],
      });
    }
  }

  const override = await getTenantEntitlementOverride(adminId);
  if (source?.subscriptionPlan && override?.active) {
    source = {
      ...source,
      subscriptionPlan: {
        ...source.subscriptionPlan,
        features: applyTenantFeatureOverrides(
          source.subscriptionPlan.features ?? [],
          override.features,
          true,
        ),
      },
    };
  }

  const entitlements = deriveWebsiteEntitlements(source);
  const defaultTtl = ttlForKey(CacheTtl.entitlements, key);
  const overrideTtl = override?.expiresAt
    ? Math.max(1, Math.ceil((new Date(override.expiresAt).getTime() - Date.now()) / 1000))
    : defaultTtl;
  void redis
    .setex(key, Math.min(defaultTtl, overrideTtl), JSON.stringify(entitlements))
    .catch(() => {});
  return entitlements;
};

const getForUser = async (user: IRequestUser): Promise<WebsiteEntitlements> => getForAdminId(await getAdminId(user));

const assertTemplateAllowed = (template: Pick<WebsiteTemplateDefinition, "tier" | "name">, entitlements: WebsiteEntitlements) => {
  if (template.tier === "PRO" && !entitlements.premiumTemplates) {
    throw new AppError(status.FORBIDDEN, `${template.name} is a premium website template. Upgrade your plan to use it.`, {
      code: "WEBSITE_PREMIUM_TEMPLATE_REQUIRED",
      retryable: false,
    });
  }
};

const assertCustomDomainsAllowed = (entitlements: WebsiteEntitlements) => {
  if (!entitlements.customDomains || entitlements.customDomainLimit < 1) {
    throw new AppError(status.FORBIDDEN, "Your current plan does not include custom domains. Your free website subdomain remains available.", {
      code: "WEBSITE_CUSTOM_DOMAIN_REQUIRED",
      retryable: false,
    });
  }
};

const assertAnalyticsWindow = (days: number, entitlements: WebsiteEntitlements) => {
  if (days > entitlements.analyticsHistoryDays) {
    throw new AppError(status.FORBIDDEN, `Your plan includes ${entitlements.analyticsHistoryDays} days of website analytics history. Upgrade for a longer range.`, {
      code: "WEBSITE_ANALYTICS_HISTORY_LIMIT",
      retryable: false,
    });
  }
};

export const WebsiteEntitlementService = {
  getForAdminId,
  getForUser,
  assertTemplateAllowed,
  assertCustomDomainsAllowed,
  assertAnalyticsWindow,
};
