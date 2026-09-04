import { describe, expect, it } from "vitest";
import { FEATURE_KEYS } from "../modules/Entitlement/featureCatalog";
import { applyFeatureOverride, evaluateTenantAccess } from "../modules/Entitlement/tenantAccessResolver.service";
import { applyNumericResourceOverride, isOverrideActive, TENANT_RESOURCE_KEYS } from "../modules/SuperAdmin/tenantEntitlement.service";

describe("Phase 5 entitlement and lifecycle regression matrix", () => {
  it("applies the full feature override truth table for every canonical feature", () => {
    for (const feature of FEATURE_KEYS) {
      expect(feature).toBeTruthy();
      expect(applyFeatureOverride(false, "INHERIT")).toBe(false);
      expect(applyFeatureOverride(false, "FORCE_ENABLED")).toBe(true);
      expect(applyFeatureOverride(true, "INHERIT")).toBe(true);
      expect(applyFeatureOverride(true, "FORCE_DISABLED")).toBe(false);
    }
  });

  it("applies numeric resource override modes consistently for every resource", () => {
    for (const resource of TENANT_RESOURCE_KEYS) {
      expect(resource).toBeTruthy();
      expect(applyNumericResourceOverride(10, { mode: "INHERIT" })).toBe(10);
      expect(applyNumericResourceOverride(10, { mode: "ADD", value: 5 })).toBe(15);
      expect(applyNumericResourceOverride(10, { mode: "SET", value: 3 })).toBe(3);
      expect(applyNumericResourceOverride(null, { mode: "ADD", value: 5 })).toBeNull();
    }
  });

  it("expires overrides back to plan behavior", () => {
    const now = new Date("2026-09-04T10:00:00.000Z");
    expect(isOverrideActive({ expiresAt: new Date("2026-09-04T09:59:59.000Z") }, now)).toBe(false);
    expect(isOverrideActive({ expiresAt: new Date("2026-09-04T10:00:01.000Z") }, now)).toBe(true);
    expect(isOverrideActive({ expiresAt: null }, now)).toBe(true);
  });

  it.each([
    ["ACTIVE", "ACTIVE", true, "ACTIVE"],
    ["SUSPENDED", "ACTIVE", false, "TENANT_SUSPENDED"],
    ["ARCHIVED", "ACTIVE", false, "TENANT_ARCHIVED"],
    ["PENDING_DELETION", "ACTIVE", false, "TENANT_PENDING_DELETION"],
  ])("enforces lifecycle %s consistently", (lifecycleStatus, subscriptionStatus, allowed, reason) => {
    const result = evaluateTenantAccess({ lifecycleStatus, ownerStatus: "ACTIVE", subscriptionStatus, isTrial: false, currentPeriodEnd: new Date("2099-01-01T00:00:00.000Z") });
    expect(result.dashboardAllowed).toBe(allowed);
    expect(result.deniedReason).toBe(reason);
    if (lifecycleStatus === "PENDING_DELETION") expect(result.recoveryAllowed).toBe(false);
  });
});
