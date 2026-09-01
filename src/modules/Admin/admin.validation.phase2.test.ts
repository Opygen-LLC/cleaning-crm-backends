import { describe, expect, it } from "vitest";
import { ServiceCategory } from "../../generated/prisma/enums";
import { adminValidation } from "./admin.validation";

const validPayload = {
  services: [
    {
      serviceName: "Standard Cleaning",
      description: "Routine residential cleaning",
      basePrice: 60,
      duration: "2h",
      category: ServiceCategory.RESIDENTIAL,
      onlineBookingEnabled: true,
      addOns: [],
    },
  ],
  booking: {
    enabled: true,
    bookingFormId: null,
    showNavigation: true,
    showHeaderCta: true,
    showServiceCtas: true,
    showHomeCta: true,
    showAvailableSlots: false,
    showPrices: true,
    showStartingPrices: true,
    showServiceDuration: true,
    ctaLabel: "Book Now",
  },
};

describe("Phase 2 atomic onboarding services request contract", () => {
  it("accepts the canonical machine service category", () => {
    expect(adminValidation.saveOnboardingServices.safeParse(validPayload).success).toBe(true);
  });

  it("rejects legacy service categories on new writes", () => {
    const parsed = adminValidation.saveOnboardingServices.safeParse({
      ...validPayload,
      services: [{ ...validPayload.services[0], category: "STANDARD" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects booking enablement without a selected online-bookable service", () => {
    const parsed = adminValidation.saveOnboardingServices.safeParse({
      ...validPayload,
      services: [{ ...validPayload.services[0], onlineBookingEnabled: false }],
    });
    expect(parsed.success).toBe(false);
  });


  it("accepts a stable ServiceCatalog id for an existing onboarding service", () => {
    const parsed = adminValidation.saveOnboardingServices.safeParse({
      ...validPayload,
      services: [{
        ...validPayload.services[0],
        serviceCatalogId: "11111111-1111-4111-8111-111111111111",
      }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects the same ServiceCatalog id more than once", () => {
    const serviceCatalogId = "11111111-1111-4111-8111-111111111111";
    const parsed = adminValidation.saveOnboardingServices.safeParse({
      ...validPayload,
      services: [
        { ...validPayload.services[0], serviceCatalogId },
        {
          ...validPayload.services[0],
          serviceCatalogId,
          serviceName: "Second Service",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});
