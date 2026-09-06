import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { normalizeSubscriptionPlanFeatures, type SubscriptionPlanFeature } from "../../lib/utils/subscriptionPlanFeatures";
import { TenantAccessResolver, type TenantAccessResolution } from "../Entitlement/tenantAccessResolver.service";
import type { FeatureKey } from "../Entitlement/featureCatalog";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type { WebsiteTemplateDefinition } from "./templateRegistry";

export const MAX_WEBSITE_ANALYTICS_HISTORY_DAYS = 730 as const;

export const WEBSITE_ENTITLEMENT_FEATURES = Object.freeze({
  CUSTOM_DOMAINS: "custom_domain" as const,
  PREMIUM_TEMPLATES: "premium_templates" as const,
  ANALYTICS_HISTORY: "website_analytics" as const,
  ADVANCED_SEO: "advanced_seo" as const,
});

export interface WebsiteEntitlements {
  planName: string;
  basicWebsite: boolean;
  freeSubdomain: boolean;
  onlineBooking: boolean;
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

const featureByKey = (features: SubscriptionPlanFeature[], key: FeatureKey) =>
  features.find((feature) => feature.key === key) ?? null;

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
  if (!source || source.status !== "ACTIVE") return false;
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

  const customDomainsFeature = featureByKey(features, WEBSITE_ENTITLEMENT_FEATURES.CUSTOM_DOMAINS);
  const premiumFeature = featureByKey(features, WEBSITE_ENTITLEMENT_FEATURES.PREMIUM_TEMPLATES);
  const analyticsFeature = featureByKey(features, WEBSITE_ENTITLEMENT_FEATURES.ANALYTICS_HISTORY);
  const advancedSeoFeature = featureByKey(features, WEBSITE_ENTITLEMENT_FEATURES.ADVANCED_SEO);

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

const getForAdminId = async (adminId: string, suppliedAccess?: TenantAccessResolution): Promise<WebsiteEntitlements> => {
  const access = suppliedAccess ?? await TenantAccessResolver.resolve(adminId);
  const defaults = planDefaults(access.plan.name);
  const planFeatures = access.plan.features;
  const customFeature = featureByKey(planFeatures, "custom_domain");
  const analyticsFeature = featureByKey(planFeatures, "website_analytics");

  const customDomains = access.effectiveEntitlements.custom_domain;
  const customDomainLimit = customDomains
    ? Math.max(1, parsePositiveInteger(customFeature?.limit, defaults.customDomainLimit || 1))
    : 0;
  const analyticsHistoryDays = access.effectiveEntitlements.website_analytics
    ? parsePositiveInteger(analyticsFeature?.limit, defaults.analyticsHistoryDays)
    : 30;

  return {
    planName: access.plan.name ?? "STARTER",
    basicWebsite: access.effectiveEntitlements.website,
    freeSubdomain: access.effectiveEntitlements.website,
    onlineBooking: access.effectiveEntitlements.online_booking,
    customDomains,
    customDomainLimit,
    premiumTemplates: access.effectiveEntitlements.premium_templates,
    analyticsHistoryDays: Math.min(MAX_WEBSITE_ANALYTICS_HISTORY_DAYS, Math.max(30, analyticsHistoryDays)),
    advancedSeo: access.effectiveEntitlements.advanced_seo,
  };
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
