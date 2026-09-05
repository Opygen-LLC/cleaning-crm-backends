import { describe, expect, it } from "vitest";
import { assertWebsiteDesignPublishable } from "./websiteComponentRegistry";
import type { WebsiteEntitlements } from "./websiteEntitlement.service";

const entitlements = (overrides: Partial<WebsiteEntitlements> = {}): WebsiteEntitlements => ({
  planName: "STARTER",
  basicWebsite: true,
  freeSubdomain: true,
  onlineBooking: true,
  customDomains: false,
  customDomainLimit: 0,
  premiumTemplates: false,
  analyticsHistoryDays: 30,
  advancedSeo: false,
  ...overrides,
});

const design = (componentOverrides: Record<string, unknown>) => ({
  schemaVersion: 1 as const,
  componentOverrides,
  componentAnimations: {},
  sectionStyles: {},
  animationsEnabled: true,
});

describe("Website component publication validation", () => {
  it("rejects a known component when it is assigned to the wrong slot", () => {
    try {
      assertWebsiteDesignPublishable(
        design({ home: { hero: "shared.header.minimal.v1" } }),
        entitlements(),
      );
      throw new Error("expected slot mismatch");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 422, code: "WEBSITE_COMPONENT_SLOT_MISMATCH", retryable: false });
    }
  });

  it("re-checks premium component entitlement at the publish boundary", () => {
    try {
      assertWebsiteDesignPublishable(
        design({ shared: { header: "shared.header.modern-glass.v1" } }),
        entitlements({ premiumTemplates: false }),
      );
      throw new Error("expected premium entitlement rejection");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 403, code: "WEBSITE_PREMIUM_COMPONENT_REQUIRED", retryable: false });
    }

    expect(() => assertWebsiteDesignPublishable(
      design({ shared: { header: "shared.header.modern-glass.v1" } }),
      entitlements({ premiumTemplates: true }),
    )).not.toThrow();
  });
});
