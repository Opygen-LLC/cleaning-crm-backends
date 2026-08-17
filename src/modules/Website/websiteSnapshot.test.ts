import { describe, expect, it } from "vitest";
import { buildPublishedSnapshot, parsePublishedSnapshot, parseRevisionSnapshotAsPublished, selectPublishedIntegrationFormId } from "./websiteSnapshot";

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

  it("stores website booking presentation controls inside the immutable snapshot", () => {
    const snapshot = buildPublishedSnapshot({
      ...draft,
      primaryBookingFormId: "booking-1",
      bookingEnabled: false,
      bookingShowHeaderCta: false,
      bookingShowServiceCtas: false,
      bookingShowHomeCta: false,
      bookingShowAvailableSlots: false,
      bookingShowPrices: false,
    });

    expect(snapshot.website).toEqual(expect.objectContaining({
      bookingEnabled: false,
      bookingShowHeaderCta: false,
      bookingShowServiceCtas: false,
      bookingShowHomeCta: false,
      bookingShowAvailableSlots: false,
      bookingShowPrices: false,
    }));
  });

  it("stores estimate availability inside the immutable publication snapshot", () => {
    const snapshot = buildPublishedSnapshot({
      ...draft,
      primaryEstimateFormId: "estimate-1",
      estimateEnabled: true,
    });

    expect(snapshot.website.primaryEstimateFormId).toBe("estimate-1");
    expect(snapshot.website.estimateEnabled).toBe(true);
  });

  it("keeps legacy estimate snapshots live when they already had an attached form", () => {
    const snapshot = buildPublishedSnapshot({
      ...draft,
      primaryEstimateFormId: "estimate-legacy",
      estimateEnabled: true,
    });
    const legacy = JSON.parse(JSON.stringify(snapshot));
    delete legacy.website.estimateEnabled;

    expect(parsePublishedSnapshot(legacy)?.website.estimateEnabled).toBe(true);
  });

  it("defaults legacy V1 snapshots to the previous booking presentation behavior", () => {
    const snapshot = buildPublishedSnapshot(draft);
    const legacy = JSON.parse(JSON.stringify(snapshot));
    delete legacy.website.bookingEnabled;
    delete legacy.website.bookingShowHeaderCta;
    delete legacy.website.bookingShowServiceCtas;
    delete legacy.website.bookingShowHomeCta;
    delete legacy.website.bookingShowAvailableSlots;
    delete legacy.website.bookingShowPrices;

    expect(parsePublishedSnapshot(legacy)?.website).toEqual(expect.objectContaining({
      bookingEnabled: true,
      bookingShowHeaderCta: true,
      bookingShowServiceCtas: true,
      bookingShowHomeCta: true,
      bookingShowAvailableSlots: true,
      bookingShowPrices: true,
    }));
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

  it("converts a stored WebsiteRevision draft snapshot through the public V1 contract", () => {
    const revisionSnapshot = {
      id: "website-1",
      adminId: "admin-1",
      subdomain: "bio-cleaning",
      status: "PUBLISHED",
      domains: [{ domain: "www.biocleaning.co.uk", verificationToken: "must-not-leak" }],
      assets: [{ publicId: "asset-1" }],
      ...draft,
    };

    const parsed = parseRevisionSnapshotAsPublished(revisionSnapshot);
    expect(parsed?.website.templateId).toBe("clean-modern");
    expect(parsed?.pages[0].content).toEqual({ heroTitle: "Hello" });
    expect(parsed).not.toHaveProperty("domains");
    expect(parsed).not.toHaveProperty("assets");
    expect(parsed).not.toHaveProperty("subdomain");
  });

  it("deep-copies page content", () => {
    const snapshot = buildPublishedSnapshot(draft);
    (draft.pages[0].content as { heroTitle: string }).heroTitle = "Changed";
    expect((snapshot.pages[0].content as { heroTitle: string }).heroTitle).toBe("Hello");
  });
});
