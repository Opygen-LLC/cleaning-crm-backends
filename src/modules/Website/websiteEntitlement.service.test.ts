import { describe, expect, it } from "vitest";
import { deriveWebsiteEntitlements, MAX_WEBSITE_ANALYTICS_HISTORY_DAYS, WebsiteEntitlementService } from "./websiteEntitlement.service";

const future = () => new Date(Date.now() + 86_400_000);
const past = () => new Date(Date.now() - 86_400_000);

describe("website subscription entitlements", () => {
  it("keeps the acquisition core on the base plan", () => {
    const result = deriveWebsiteEntitlements({
      status: "ACTIVE",
      isTrial: false,
      currentPeriodEnd: future(),
      subscriptionPlan: {
        name: "STARTER",
        features: [{ label: "Online Booking", included: false }],
      },
    });

    expect(result).toMatchObject({
      planName: "STARTER",
      basicWebsite: true,
      freeSubdomain: true,
      onlineBooking: true,
      customDomains: false,
      customDomainLimit: 0,
      premiumTemplates: false,
      analyticsHistoryDays: 30,
      advancedSeo: false,
    });
  });

  it("uses Growth defaults for premium website capabilities", () => {
    const result = deriveWebsiteEntitlements({
      status: "ACTIVE",
      isTrial: false,
      currentPeriodEnd: future(),
      subscriptionPlan: { name: "GROWTH", features: [] },
    });

    expect(result).toMatchObject({
      customDomains: true,
      customDomainLimit: 1,
      premiumTemplates: true,
      analyticsHistoryDays: 90,
      advancedSeo: true,
    });
  });

  it("allows canonical plan-feature entries to override tier defaults and limits", () => {
    const result = deriveWebsiteEntitlements({
      status: "ACTIVE",
      isTrial: false,
      currentPeriodEnd: future(),
      subscriptionPlan: {
        name: "PRO",
        features: [
          { label: "Custom Domains", included: true, limit: "2 domains" },
          { label: "Premium Website Templates", included: false },
          { label: "Website Analytics History", included: true, limit: "180 days" },
          { label: "Advanced Website SEO", included: false },
        ],
      },
    });

    expect(result).toMatchObject({
      customDomains: true,
      customDomainLimit: 2,
      premiumTemplates: false,
      analyticsHistoryDays: 180,
      advancedSeo: false,
    });
  });

  it("treats disabled analytics-history entitlement as the base 30-day window", () => {
    const result = deriveWebsiteEntitlements({
      status: "ACTIVE",
      isTrial: false,
      currentPeriodEnd: future(),
      subscriptionPlan: {
        name: "PRO",
        features: [{ label: "Website Analytics History", included: false, limit: "365 days" }],
      },
    });

    expect(result.analyticsHistoryDays).toBe(30);
  });

  it("falls back to base entitlements after subscription expiry without disabling the website core", () => {
    const result = deriveWebsiteEntitlements({
      status: "ACTIVE",
      isTrial: false,
      currentPeriodEnd: past(),
      subscriptionPlan: { name: "PRO", features: [] },
    });

    expect(result.planName).toBe("STARTER");
    expect(result.basicWebsite).toBe(true);
    expect(result.freeSubdomain).toBe(true);
    expect(result.onlineBooking).toBe(true);
    expect(result.customDomains).toBe(false);
    expect(result.premiumTemplates).toBe(false);
  });

  it("blocks premium templates on the base entitlement", () => {
    const entitlements = deriveWebsiteEntitlements({
      status: "ACTIVE",
      isTrial: false,
      currentPeriodEnd: future(),
      subscriptionPlan: { name: "STARTER", features: [] },
    });

    try {
      WebsiteEntitlementService.assertTemplateAllowed({ tier: "PRO", name: "Premium Home" }, entitlements);
      throw new Error("Expected premium template restriction");
    } catch (error: any) {
      expect(error?.meta?.code ?? error?.details?.code ?? error?.code).toBe("WEBSITE_PREMIUM_TEMPLATE_REQUIRED");
      expect(String(error?.message ?? "")).toMatch(/premium website template/i);
    }
  });

  it("caps analytics history at the supported aggregate horizon", () => {
    const result = deriveWebsiteEntitlements({
      status: "ACTIVE",
      isTrial: false,
      currentPeriodEnd: future(),
      subscriptionPlan: {
        name: "CUSTOM",
        features: [{ label: "Website Analytics History", included: true, limit: "9999 days" }],
      },
    });

    expect(result.analyticsHistoryDays).toBe(MAX_WEBSITE_ANALYTICS_HISTORY_DAYS);
  });
});
