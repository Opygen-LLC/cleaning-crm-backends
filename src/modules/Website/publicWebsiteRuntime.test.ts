import { describe, expect, it } from "vitest";
import { DEFAULT_WEBSITE_PAGES } from "./website.constant";
import { TemplateRegistry } from "./templateRegistry";
import { projectCanonicalService, projectPublicBusiness } from "../../lib/utils/canonicalProjection";

describe("Phase 3 public website runtime contract", () => {
  it("provisions the complete Clean Modern route set", () => {
    expect(DEFAULT_WEBSITE_PAGES.map((page) => page.slug)).toEqual([
      "/",
      "/services",
      "/about",
      "/reviews",
      "/contact",
      "/book",
      "/estimate",
    ]);
    expect(new Set(DEFAULT_WEBSITE_PAGES.map((page) => page.slug)).size).toBe(7);
  });

  it("keeps marketing copy in page content while CRM entities stay dynamic", () => {
    const marketingKinds = new Set(["HOME", "SERVICES", "ABOUT", "REVIEWS", "CONTACT"]);
    for (const page of DEFAULT_WEBSITE_PAGES) {
      if (!marketingKinds.has(page.kind)) continue;
      expect(page.content).toBeTruthy();
      expect(typeof page.content).toBe("object");
      expect("services" in page.content).toBe(false);
      expect("reviews" in page.content).toBe(false);
      expect("serviceAreas" in page.content).toBe(false);
    }
  });

  it("projects live CRM currency and canonical service identity for the runtime", () => {
    const business = projectPublicBusiness({
      businessName: "Acme Cleaning",
      currency: "CAD",
    });
    const service = projectCanonicalService({
      id: "service-1",
      serviceName: "Deep Clean",
      description: "Deep cleaning",
      basePriceGbp: 125,
      duration: "3h",
      category: "Residential",
      addOns: [],
      legacyServiceType: "DEEP_CLEANING",
    });

    expect(business.currency).toBe("CAD");
    expect(service.serviceCatalogId).toBe("service-1");
    expect(service.basePrice).toBe(125);
    expect(service.basePriceGbp).toBe(125);
  });

  it("registers Clean Modern as the first public runtime template", () => {
    const template = TemplateRegistry.requireTemplate("clean-modern", "1.0.0");
    expect(template.capabilities.booking).toBe(true);
    expect(template.capabilities.estimate).toBe(true);
    expect(template.capabilities.reviews).toBe(true);
    expect(template.capabilities.serviceAreas).toBe(true);
  });
});
