import { describe, expect, it } from "vitest";
import { buildWebsiteDomainLifecycle, presentWebsiteDomain } from "./websiteDomainLifecycle";

const base = {
  domain: "www.biocleaning.co.uk",
  status: "PENDING",
  ownershipVerified: false,
  providerVerified: false,
  routingVerified: false,
  tlsStatus: "PENDING",
  lastProviderSyncAt: null,
};

describe("custom domain lifecycle", () => {
  it("maps the production workflow to owner-facing states", () => {
    expect(buildWebsiteDomainLifecycle(base).status).toBe("PENDING_VERIFICATION");
    expect(buildWebsiteDomainLifecycle({ ...base, ownershipVerified: true }).status).toBe("OWNERSHIP_VERIFIED");
    expect(buildWebsiteDomainLifecycle({ ...base, ownershipVerified: true, lastProviderSyncAt: new Date() }).status).toBe("DNS_PENDING");
    expect(buildWebsiteDomainLifecycle({
      ...base,
      ownershipVerified: true,
      providerVerified: true,
      routingVerified: true,
      tlsStatus: "PROVISIONING",
      lastProviderSyncAt: new Date(),
    }).status).toBe("SSL_PROVISIONING");
    expect(buildWebsiteDomainLifecycle({
      ...base,
      status: "VERIFIED",
      ownershipVerified: true,
      providerVerified: true,
      routingVerified: true,
      tlsStatus: "READY",
      lastProviderSyncAt: new Date(),
    }).status).toBe("ACTIVE");
    expect(buildWebsiteDomainLifecycle({ ...base, status: "FAILED" }).status).toBe("FAILED");
  });

  it("marks ownership, DNS and SSL independently", () => {
    const lifecycle = buildWebsiteDomainLifecycle({
      ...base,
      ownershipVerified: true,
      providerVerified: true,
      routingVerified: true,
      tlsStatus: "PROVISIONING",
      lastProviderSyncAt: new Date(),
    });
    expect(lifecycle.steps.map((step) => [step.key, step.status])).toEqual([
      ["ownership", "COMPLETE"],
      ["dns", "COMPLETE"],
      ["ssl", "PENDING"],
    ]);
  });

  it("never exposes the raw verification token in the API presenter", () => {
    const presented = presentWebsiteDomain({
      ...base,
      id: "domain-1",
      verificationToken: "secret-ish-token",
      verificationStartedAt: new Date(),
    });
    expect("verificationToken" in presented).toBe(false);
    expect("verificationStartedAt" in presented).toBe(false);
    expect(presented.lifecycle.publicUrl).toBe("https://www.biocleaning.co.uk");
  });
});
