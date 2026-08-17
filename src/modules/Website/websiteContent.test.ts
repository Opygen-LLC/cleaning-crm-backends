import { describe, expect, it } from "vitest";
import { validateWebsitePageContent } from "./websiteContent";

describe("website structured content", () => {
  it("accepts the Phase 7 Home fields and preserves legacy compatible keys", () => {
    const content = validateWebsitePageContent("HOME", {
      eyebrow: "Eco cleaning",
      heroTitle: "Eco-Friendly Cleaning in London",
      heroSubtitle: "A cleaner home without harsh chemicals.",
      primaryCtaLabel: "Book Online",
      secondaryCtaLabel: "View Services",
      servicesHeading: "Our services",
      aboutHeading: "About Bio Cleaning",
      reviewsHeading: "What customers say",
      areasHeading: "Areas we cover",
      finalCtaHeading: "Ready for a healthier clean?",
      aboutBody: "Legacy content remains supported.",
    });
    expect(content.heroTitle).toBe("Eco-Friendly Cleaning in London");
    expect(content.finalCtaHeading).toBe("Ready for a healthier clean?");
    expect(content.aboutBody).toBe("Legacy content remains supported.");
  });

  it("accepts structured About and Contact fields", () => {
    const about = validateWebsitePageContent("ABOUT", {
      heading: "About Bio Cleaning",
      body: "Professional cleaning with environmentally conscious products.",
      imageUrl: "https://res.cloudinary.com/demo/image/upload/about.webp",
      imageAlt: "Bio Cleaning team",
      values: ["Reliable", "Eco conscious"],
      yearsExperience: 12,
    });
    const contact = validateWebsitePageContent("CONTACT", {
      heading: "Talk to Bio Cleaning",
      intro: "We are happy to help.",
      phone: "+44 20 0000 0000",
      email: "hello@biocleaning.example",
      address: "24 Example Road, London",
      openingHours: "Monday-Friday: 08:00-18:00",
    });
    expect(about.yearsExperience).toBe(12);
    expect(contact.email).toBe("hello@biocleaning.example");
  });

  it("rejects invalid structured fields and oversized JSON", () => {
    expect(() => validateWebsitePageContent("CONTACT", { email: "not-an-email" })).toThrow();
    expect(() => validateWebsitePageContent("ABOUT", { yearsExperience: 999 })).toThrow();
    expect(() => validateWebsitePageContent("HOME", { heroSubtitle: "x".repeat(40_000) })).toThrow();
  });
});
