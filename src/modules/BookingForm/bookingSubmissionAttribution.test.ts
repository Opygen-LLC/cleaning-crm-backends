import { describe, expect, it } from "vitest";
import { buildBookingSubmissionAttribution } from "./bookingSubmissionAttribution";

describe("Phase 12 booking submission attribution", () => {
  it("derives website source/page from the trusted resolver context", () => {
    expect(buildBookingSubmissionAttribution("website-1", {
      utmSource: " google ",
      utmCampaign: " spring-clean ",
    })).toEqual({
      sourceWebsiteId: "website-1",
      source: "WEBSITE",
      sourcePage: "/book",
      utmSource: "google",
      utmCampaign: "spring-clean",
    });
  });

  it("keeps legacy public links separate from website acquisition", () => {
    expect(buildBookingSubmissionAttribution(undefined, {
      utmSource: "newsletter",
    })).toEqual({
      sourceWebsiteId: null,
      source: "PUBLIC_LINK",
      sourcePage: null,
      utmSource: "newsletter",
      utmCampaign: null,
    });
  });

  it("bounds UTM values before persistence", () => {
    const result = buildBookingSubmissionAttribution("website-1", {
      utmSource: "s".repeat(200),
      utmCampaign: "c".repeat(220),
    });
    expect(result.utmSource).toHaveLength(120);
    expect(result.utmCampaign).toHaveLength(160);
  });
});
