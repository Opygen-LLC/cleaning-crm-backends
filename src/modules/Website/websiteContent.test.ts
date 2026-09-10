import { describe, expect, it } from "vitest";
import { validateWebsitePageContent } from "./websiteContent";

describe("website structured content", () => {
  it("accepts the Phase 5 presentation fields without accepting CRM entities", () => {
    const content = validateWebsitePageContent("HOME", {
      eyebrow: "Eco cleaning",
      heroTitle: "Eco-Friendly Cleaning in London",
      heroSubtitle: "A cleaner home without harsh chemicals.",
      primaryCtaLabel: "Book Online",
      secondaryCtaLabel: "View Services",
      servicesHeading: "Our services",
      servicesIntro: "Choose a live service from our catalog.",
      aboutHeading: "About Bio Cleaning",
      aboutBody: "Reliable local cleaning.",
      whyHeading: "Why choose us",
      whyIntro: "Simple, reliable and transparent.",
      whyItems: [
        { title: "Reliable", description: "Clear scheduling and communication." },
        { title: "Current", description: "Website service data stays connected to the CRM." },
      ],
      reviewsHeading: "What customers say",
      reviewsIntro: "Published feedback from real customers.",
      areasHeading: "Areas we cover",
      contactHeading: "Talk to us",
      contactBody: "We are happy to help you choose a service.",
      finalCtaHeading: "Ready for a healthier clean?",
      footerDescription: "Professional cleaning made simple.",
      footerTrustText: "Service information maintained by the business.",
      socialLinks: {
        facebook: "https://facebook.com/example",
        instagram: "https://instagram.com/example",
      },
      // Known system pages are presentation-only. These must never survive.
      services: [{ id: "service-1", name: "Copied service" }],
      reviews: [{ id: "review-1", rating: 5 }],
      bookingForm: { id: "form-1" },
    });

    expect(content.heroTitle).toBe("Eco-Friendly Cleaning in London");
    expect(content.whyItems).toHaveLength(2);
    expect(content.socialLinks).toEqual({
      facebook: "https://facebook.com/example",
      instagram: "https://instagram.com/example",
    });
    expect(content).not.toHaveProperty("services");
    expect(content).not.toHaveProperty("reviews");
    expect(content).not.toHaveProperty("bookingForm");
  });

  it("keeps ServiceCatalog, Review and BookingForm data out of system page JSON", () => {
    const services = validateWebsitePageContent("SERVICES", {
      heading: "Our services",
      intro: "Live catalog below.",
      services: [{ id: "copied" }],
      items: [{ id: "also-copied" }],
    });
    const reviews = validateWebsitePageContent("REVIEWS", {
      heading: "Reviews",
      testimonials: [{ clientName: "Copied customer" }],
      reviews: [{ rating: 5 }],
    });
    const booking = validateWebsitePageContent("BOOK", {
      heading: "Book online",
      form: { id: "form-1", fields: [] },
      services: [{ id: "service-1" }],
      prices: [100],
    });

    expect(services).toEqual({ heading: "Our services", intro: "Live catalog below." });
    expect(reviews).toEqual({ heading: "Reviews" });
    expect(booking).toEqual({ heading: "Book online" });
  });

  it("accepts structured About fields and strips duplicated CRM contact data", () => {
    const about = validateWebsitePageContent("ABOUT", {
      heading: "About Bio Cleaning",
      body: "Professional cleaning with environmentally conscious products.",
      imageUrl: "https://media.cleaningcrm.opygen.com/organizations/admin/website/site/content/about.webp",
      imageAlt: "Bio Cleaning team",
      values: ["Reliable", "Eco conscious"],
      yearsExperience: 12,
    });
    const contact = validateWebsitePageContent("CONTACT", {
      eyebrow: "Contact",
      heading: "Talk to Bio Cleaning",
      intro: "We are happy to help.",
      phone: "+44 20 0000 0000",
      email: "hello@biocleaning.example",
      address: "24 Example Road, London",
      openingHours: "Monday-Friday: 08:00-18:00",
    });
    expect(about.yearsExperience).toBe(12);
    expect(contact).toEqual({ eyebrow: "Contact", heading: "Talk to Bio Cleaning", intro: "We are happy to help." });
  });

  it("requires safe HTTPS social links and rejects oversized JSON", () => {
    expect(() => validateWebsitePageContent("HOME", {
      socialLinks: { facebook: "javascript:alert(1)" },
    })).toThrow();
    expect(() => validateWebsitePageContent("ABOUT", { yearsExperience: 999 })).toThrow();
    expect(() => validateWebsitePageContent("HOME", { heroSubtitle: "x".repeat(40_000) })).toThrow();
  });
});
