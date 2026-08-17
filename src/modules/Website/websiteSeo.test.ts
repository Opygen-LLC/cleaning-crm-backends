import { describe, expect, it } from "vitest";
import { buildDefaultWebsiteSeo } from "./websiteSeo";

describe("website SEO defaults", () => {
  it("builds a location-aware title for a newly provisioned cleaning business", () => {
    expect(buildDefaultWebsiteSeo({
      businessName: "Bio Cleaning",
      city: "London",
      businessDescription: null,
    }).title).toBe("Bio Cleaning | Professional Cleaning in London");
  });

  it("uses canonical CRM business description before generated copy", () => {
    expect(buildDefaultWebsiteSeo({
      businessName: "Bio Cleaning",
      city: "London",
      businessDescription: "Eco-friendly residential and commercial cleaning across London.",
    }).description).toBe("Eco-friendly residential and commercial cleaning across London.");
  });

  it("keeps generated metadata bounded", () => {
    const result = buildDefaultWebsiteSeo({
      businessName: "A Very Long Cleaning Business Name That Still Needs A Useful Search Result",
      city: "A City With A Surprisingly Long Locality Name",
      businessDescription: "x".repeat(500),
    });
    expect(result.title.length).toBeLessThanOrEqual(70);
    expect(result.description.length).toBeLessThanOrEqual(180);
  });
});
