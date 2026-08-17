import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  baseDomain: "sites.example.com",
  customDomainsEnabled: true,
}));

vi.mock("../../config/ENV", () => ({
  get WEBSITE_BASE_DOMAIN() { return env.baseDomain; },
  get WEBSITE_CUSTOM_DOMAINS_ENABLED() { return env.customDomainsEnabled; },
}));

import { getCanonicalWebsiteHost, getCanonicalWebsiteOrigin } from "./websiteCanonicalHost";

beforeEach(() => {
  env.baseDomain = "sites.example.com";
  env.customDomainsEnabled = true;
});

describe("canonical website host", () => {
  it("uses the active primary custom domain for both routing and SEO", () => {
    expect(getCanonicalWebsiteHost("bio-cleaning", "www.biocleaning.co.uk"))
      .toBe("www.biocleaning.co.uk");
    expect(getCanonicalWebsiteOrigin("bio-cleaning", "www.biocleaning.co.uk"))
      .toBe("https://www.biocleaning.co.uk");
  });

  it("falls back to the current free subdomain when there is no healthy primary custom domain", () => {
    expect(getCanonicalWebsiteHost("bio-cleaning", null))
      .toBe("bio-cleaning.sites.example.com");
    expect(getCanonicalWebsiteOrigin("bio-cleaning", null))
      .toBe("https://bio-cleaning.sites.example.com");
  });

  it("ignores a custom hostname when custom domains are disabled", () => {
    env.customDomainsEnabled = false;
    expect(getCanonicalWebsiteHost("bio-cleaning", "www.biocleaning.co.uk"))
      .toBe("bio-cleaning.sites.example.com");
  });

  it("returns no canonical host when the deployment has no public base domain", () => {
    env.baseDomain = "";
    env.customDomainsEnabled = false;
    expect(getCanonicalWebsiteHost("bio-cleaning", null)).toBeNull();
    expect(getCanonicalWebsiteOrigin("bio-cleaning", null)).toBeNull();
  });
});
