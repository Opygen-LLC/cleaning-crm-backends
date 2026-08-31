import { describe, expect, it } from "vitest";
import { websiteValidation } from "./website.validation";

describe("Phase 7 website publish/SEO/GA validation", () => {
  it("allows an empty publish payload for an unchanged publish/retry", () => {
    expect(websiteValidation.publishWebsite.safeParse({}).success).toBe(true);
  });

  it("accepts complete global and page SEO plus a valid GA4 measurement id", () => {
    const result = websiteValidation.publishWebsite.safeParse({
      expectedRevisionNumber: 7,
      website: {
        metaTitle: "Clean Home Services",
        metaDescription: "Residential and commercial cleaning.",
        metaKeywords: ["cleaning", "home cleaning"],
        socialImageUrl: "https://cdn.example.com/og.webp",
        indexSite: true,
        googleAnalyticsEnabled: true,
        googleAnalyticsMeasurementId: "G-ABC1234567",
      },
      pages: [{
        id: "550e8400-e29b-41d4-a716-446655440000",
        title: "Home",
        seoTitle: "Home Cleaning",
        seoDescription: "Book home cleaning online.",
        seoKeywords: ["home cleaning"],
        socialImageUrl: "https://cdn.example.com/home-og.webp",
        isEnabled: true,
      }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid GA identifiers and embedded non-URL OG images", () => {
    expect(websiteValidation.publishWebsite.safeParse({
      website: { googleAnalyticsEnabled: true, googleAnalyticsMeasurementId: "UA-123" },
    }).success).toBe(false);
    expect(websiteValidation.publishWebsite.safeParse({
      website: { socialImageUrl: "data:image/png;base64,AAAA" },
    }).success).toBe(false);
  });

  it("requires local preview to carry website and page arrays instead of persisting a draft", () => {
    expect(websiteValidation.previewLocalDraft.safeParse({ website: {}, pages: [] }).success).toBe(true);
    expect(websiteValidation.previewLocalDraft.safeParse({ website: {} }).success).toBe(false);
  });
});
