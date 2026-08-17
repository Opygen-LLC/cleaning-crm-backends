import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, publicWebsiteMock } = vi.hoisted(() => ({
  prismaMock: {
    websiteAnalyticsEvent: { create: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    businessWebsite: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
  publicWebsiteMock: {
    resolveIdentifier: vi.fn(),
    getPublicWebsiteById: vi.fn(),
  },
}));

vi.mock("../../config/ENV", () => ({
  ANALYTICS_HASH_SECRET: "analytics-test-secret",
  BETTER_AUTH_SECRET: "auth-test-secret",
}));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn() }));
vi.mock("./publicWebsite.service", () => ({ PublicWebsiteService: publicWebsiteMock }));

import { WebsiteAnalyticsService } from "./websiteAnalytics.service";

beforeEach(() => {
  vi.clearAllMocks();
  publicWebsiteMock.resolveIdentifier.mockResolvedValue({ websiteId: "website-1" });
  publicWebsiteMock.getPublicWebsiteById.mockResolvedValue({ pages: [{ path: "/" }, { path: "/services" }] });
  prismaMock.websiteAnalyticsEvent.create.mockResolvedValue({ id: "event-1" });
});

describe("website analytics ingestion", () => {
  it("drops fabricated paths instead of creating unbounded analytics cardinality", async () => {
    const result = await WebsiteAnalyticsService.trackPublicPageView(
      "sparkle",
      { eventType: "PAGE_VIEW", path: "/fabricated-path" },
      { ip: "203.0.113.10", userAgent: "Mozilla/5.0" },
    );

    expect(result).toEqual({ accepted: true, recorded: false });
    expect(prismaMock.websiteAnalyticsEvent.create).not.toHaveBeenCalled();
  });

  it("records only a pseudonymous visitor hash for a real public page", async () => {
    await WebsiteAnalyticsService.trackPublicPageView(
      "sparkle",
      { eventType: "PAGE_VIEW", path: "/services", metadata: { locale: "en-GB", ignored: "secret" } },
      { ip: "203.0.113.10", userAgent: "Mozilla/5.0" },
    );

    const call = prismaMock.websiteAnalyticsEvent.create.mock.calls[0]?.[0];
    expect(call.data.path).toBe("/services");
    expect(call.data.visitorHash).toMatch(/^[a-f0-9]{40}$/);
    expect(call.data.visitorHash).not.toContain("203.0.113.10");
    expect(call.data.metadata).toEqual({ locale: "en-GB" });
  });

  it("does not store crawler page views", async () => {
    const result = await WebsiteAnalyticsService.trackPublicPageView(
      "sparkle",
      { eventType: "PAGE_VIEW", path: "/" },
      { ip: "203.0.113.10", userAgent: "Googlebot/2.1" },
    );

    expect(result).toEqual({ accepted: true, recorded: false });
    expect(prismaMock.websiteAnalyticsEvent.create).not.toHaveBeenCalled();
  });
});
