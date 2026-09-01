import { describe, expect, it } from "vitest";
import { isTenantPublicApiPath, TENANT_PUBLIC_API_PREFIXES } from "./tenantPublicApiPolicy";

describe("tenant public API policy", () => {
  it("allows only the three intended public route families", () => {
    expect(TENANT_PUBLIC_API_PREFIXES).toEqual([
      "/api/v1/website/public",
      "/api/v1/quote/public",
      "/api/v1/estimate/public",
    ]);

    expect(isTenantPublicApiPath("/api/v1/website/public/softriple-4/contact")).toBe(true);
    expect(isTenantPublicApiPath("/api/v1/quote/public/token/website/site-id/action")).toBe(true);
    expect(isTenantPublicApiPath("/api/v1/estimate/public/token/website/site-id/action")).toBe(true);
  });

  it("fails closed for authenticated and look-alike route families", () => {
    for (const path of [
      "/api/v1/staff",
      "/api/v1/admin",
      "/api/v1/client",
      "/api/v1/invoice",
      "/api/v1/payment",
      "/api/v1/settings",
      "/api/v1/quote",
      "/api/v1/estimate",
      "/api/v1/website",
      "/api/v1/website/publicity",
      "/api/v1/quote/publicity/token",
      "/api/v1/estimate/publicity/token",
    ]) {
      expect(isTenantPublicApiPath(path), path).toBe(false);
    }
  });
});
