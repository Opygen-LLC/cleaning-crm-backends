import { describe, expect, it } from "vitest";
import {
  SERVICE_CATEGORIES,
  normalizeServiceCategory,
} from "./serviceCatalog.contract";
import { serviceCatalogValidation } from "./serviceCatalog.validation";

describe("service catalog contract", () => {
  it("uses one canonical category set for new writes", () => {
    expect(SERVICE_CATEGORIES).toEqual(["Residential", "Commercial", "Specialist"]);
    expect(() => serviceCatalogValidation.createServiceCatalog.parse({
      serviceName: "Test",
      description: "Test service",
      basePrice: 50,
      duration: "2h",
      category: "STANDARD",
    })).toThrow();
  });

  it("normalizes legacy category values on reads", () => {
    expect(normalizeServiceCategory("STANDARD")).toBe("Residential");
    expect(normalizeServiceCategory("OFFICE_CLEANING")).toBe("Commercial");
    expect(normalizeServiceCategory("Carpet Cleaning")).toBe("Specialist");
  });
});
