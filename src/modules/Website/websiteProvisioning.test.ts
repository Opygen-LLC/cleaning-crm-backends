import { describe, expect, it } from "vitest";
import { buildWebsiteSubdomainBase } from "./websiteProvisioning.service";

describe("buildWebsiteSubdomainBase", () => {
  it("creates a readable deterministic slug from the business name", () => {
    expect(buildWebsiteSubdomainBase("Sparkle Cleaning London", "admin-1234567890"))
      .toBe("sparkle-cleaning-london");
  });

  it("does not allocate a platform-reserved hostname", () => {
    const value = buildWebsiteSubdomainBase("Admin", "12345678-aaaa-bbbb-cccc-1234567890ab");
    expect(value).not.toBe("admin");
    expect(value.startsWith("admin-")).toBe(true);
  });

  it("uses a stable fallback when the name has no ASCII hostname characters", () => {
    expect(buildWebsiteSubdomainBase(" পরিষ্কার ", "12345678-aaaa-bbbb-cccc-1234567890ab"))
      .toBe("business-12345678aa");
  });

  it("keeps the generated label within DNS limits", () => {
    const value = buildWebsiteSubdomainBase("Very Long Cleaning Company Name ".repeat(8), "admin-1");
    expect(value.length).toBeLessThanOrEqual(63);
  });
});
