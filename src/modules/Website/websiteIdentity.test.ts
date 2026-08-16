import { describe, expect, it } from "vitest";
import { assertSafeHttpsUrl, normalizeDomain, normalizePageSlug, normalizeSubdomain } from "./websiteIdentity";

describe("website identity helpers", () => {
  it("normalizes valid tenant subdomains", () => {
    expect(normalizeSubdomain("  Sparkle-London ")).toBe("sparkle-london");
  });

  it("rejects reserved tenant subdomains", () => {
    expect(() => normalizeSubdomain("admin")).toThrow();
  });

  it("normalizes IDN/custom domain input without accepting URLs", () => {
    expect(normalizeDomain("Example.COM.")).toBe("example.com");
    expect(() => normalizeDomain("https://example.com/path")).toThrow();
  });

  it("normalizes website page paths", () => {
    expect(normalizePageSlug("services/deep-clean")).toBe("/services/deep-clean");
    expect(normalizePageSlug("/")).toBe("/");
  });

  it("requires HTTPS for public website assets", () => {
    expect(assertSafeHttpsUrl("https://cdn.example.com/logo.png", "Logo")).toBe("https://cdn.example.com/logo.png");
    expect(() => assertSafeHttpsUrl("http://cdn.example.com/logo.png", "Logo")).toThrow();
  });
});
