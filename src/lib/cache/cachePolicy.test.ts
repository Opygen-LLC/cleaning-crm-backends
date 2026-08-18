import { describe, expect, it } from "vitest";
import { CacheNamespaces, jitterTtl, ttlForKey } from "./cachePolicy";

describe("cachePolicy", () => {
  it("uses tenant-scoped Phase 9 namespaces", () => {
    expect(CacheNamespaces.authContext("user-1")).toBe("auth-context:user-1");
    expect(CacheNamespaces.subscription("admin-1")).toBe("subscription:admin-1");
    expect(CacheNamespaces.entitlements("admin-1")).toBe("entitlements:admin-1");
    expect(CacheNamespaces.dashboardSummary("admin-1", "30d:abc")).toBe("dashboard-summary:admin-1:30d:abc");
    expect(CacheNamespaces.serviceCatalog("admin-1")).toBe("service-catalog:admin-1");
    expect(CacheNamespaces.bookingForm("form-1")).toBe("booking-form:form-1");
  });

  it("keeps jitter bounded around the configured base", () => {
    for (let index = 0; index < 100; index += 1) {
      const ttl = jitterTtl(300, { ratio: 0.2 });
      expect(ttl).toBeGreaterThanOrEqual(240);
      expect(ttl).toBeLessThanOrEqual(360);
    }
  });

  it("spreads keys deterministically when a salt is supplied", () => {
    const first = ttlForKey(300, "dashboard-summary:admin-1:30d");
    const second = ttlForKey(300, "dashboard-summary:admin-1:30d");
    const other = ttlForKey(300, "dashboard-summary:admin-2:30d");
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(240);
    expect(first).toBeLessThanOrEqual(360);
    expect(other).toBeGreaterThanOrEqual(240);
    expect(other).toBeLessThanOrEqual(360);
  });
});
