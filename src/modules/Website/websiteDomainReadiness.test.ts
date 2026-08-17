import { describe, expect, it } from "vitest";
import { isWebsiteDomainRoutingReady, WEBSITE_READY_TLS_STATUSES } from "./websiteDomainReadiness";

const ready = {
  status: "VERIFIED",
  ownershipVerified: true,
  providerVerified: true,
  routingVerified: true,
  tlsStatus: "READY",
};

describe("custom-domain routing readiness", () => {
  it("requires every ownership/provider/routing/TLS gate", () => {
    expect(isWebsiteDomainRoutingReady(ready)).toBe(true);
    expect(isWebsiteDomainRoutingReady({ ...ready, ownershipVerified: false })).toBe(false);
    expect(isWebsiteDomainRoutingReady({ ...ready, providerVerified: false })).toBe(false);
    expect(isWebsiteDomainRoutingReady({ ...ready, routingVerified: false })).toBe(false);
    expect(isWebsiteDomainRoutingReady({ ...ready, tlsStatus: "PROVISIONING" })).toBe(false);
    expect(isWebsiteDomainRoutingReady({ ...ready, status: "PENDING" })).toBe(false);
  });

  it("accepts external TLS only for externally managed/manual routing", () => {
    expect(WEBSITE_READY_TLS_STATUSES).toContain("EXTERNAL");
    expect(isWebsiteDomainRoutingReady({ ...ready, tlsStatus: "EXTERNAL" })).toBe(true);
  });
});
