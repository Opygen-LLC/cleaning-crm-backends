import { describe, expect, it } from "vitest";
import { buildPublishedSnapshot, parsePublishedSnapshot, selectPublishedIntegrationFormId } from "./websiteSnapshot";

describe("website published snapshots", () => {
  const draft = {
    templateId: "clean-modern",
    templateVersion: "1.0.0",
    schemaVersion: 1,
    primaryColor: "#0F766E",
    secondaryColor: "#0F172A",
    accentColor: "#14B8A6",
    font: null,
    logo: null,
    favicon: null,
    primaryBookingFormId: null,
    primaryEstimateFormId: null,
    metaTitle: "Example",
    metaDescription: null,
    socialImageUrl: null,
    indexSite: true,
    pages: [
      {
        id: "home",
        kind: "HOME",
        slug: "/",
        title: "Home",
        content: { heroTitle: "Hello" },
        seoTitle: null,
        seoDescription: null,
        showInNavigation: true,
        isEnabled: true,
        sortOrder: 0,
      },
    ],
  };

  it("builds and parses a stable V1 snapshot", () => {
    const snapshot = buildPublishedSnapshot(draft);
    expect(parsePublishedSnapshot(snapshot)).toEqual(snapshot);
  });

  it("rejects malformed snapshots", () => {
    expect(parsePublishedSnapshot({ version: 1, website: {}, pages: [] })).toBeNull();
    expect(parsePublishedSnapshot(null)).toBeNull();
  });

  it("does not leak draft booking/estimate selections across the published boundary", () => {
    const snapshot = buildPublishedSnapshot({
      ...draft,
      primaryBookingFormId: null,
      primaryEstimateFormId: null,
    });

    expect(selectPublishedIntegrationFormId(snapshot, "draft-booking-form", "booking")).toBeNull();
    expect(selectPublishedIntegrationFormId(snapshot, "draft-estimate-form", "estimate")).toBeNull();
    expect(selectPublishedIntegrationFormId(null, "legacy-booking-form", "booking")).toBe("legacy-booking-form");
  });

  it("deep-copies page content", () => {
    const snapshot = buildPublishedSnapshot(draft);
    (draft.pages[0].content as { heroTitle: string }).heroTitle = "Changed";
    expect((snapshot.pages[0].content as { heroTitle: string }).heroTitle).toBe("Hello");
  });
});
