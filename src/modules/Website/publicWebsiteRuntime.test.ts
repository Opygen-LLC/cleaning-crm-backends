import { describe, expect, it } from "vitest";
import { DEFAULT_WEBSITE_PAGES } from "./website.constant";
import { TemplateRegistry } from "./templateRegistry";

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

  it("registers Clean Modern as the first public runtime template", () => {
    const template = TemplateRegistry.requireTemplate("clean-modern", "1.0.0");
    expect(template.capabilities.booking).toBe(true);
    expect(template.capabilities.estimate).toBe(true);
    expect(template.capabilities.reviews).toBe(true);
    expect(template.capabilities.serviceAreas).toBe(true);
  });
});
