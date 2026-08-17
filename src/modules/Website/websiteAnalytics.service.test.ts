import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, publicWebsiteMock, getAdminIdMock, redisMock } = vi.hoisted(() => ({
  prismaMock: {
    websiteAnalyticsEvent: { create: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    businessWebsite: { findUnique: vi.fn() },
    bookingFormSubmission: { count: vi.fn() },
    estimateFormSubmission: { count: vi.fn() },
    lead: { count: vi.fn() },
    $queryRaw: vi.fn(),
  },
  publicWebsiteMock: {
    resolveIdentifier: vi.fn(),
    getPublicWebsiteById: vi.fn(),
  },
  getAdminIdMock: vi.fn(),
  redisMock: { get: vi.fn(), set: vi.fn() },
}));

vi.mock("../../config/ENV", () => ({
  ANALYTICS_HASH_SECRET: "analytics-test-secret",
  BETTER_AUTH_SECRET: "auth-test-secret",
  WEBSITE_BASE_DOMAIN: "sites.example.com",
}));
vi.mock("../../config/redis", () => ({ default: redisMock }));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: getAdminIdMock }));
vi.mock("./publicWebsite.service", () => ({ PublicWebsiteService: publicWebsiteMock }));

import { WebsiteAnalyticsService } from "./websiteAnalytics.service";

beforeEach(() => {
  vi.clearAllMocks();
  publicWebsiteMock.resolveIdentifier.mockResolvedValue({ websiteId: "website-1" });
  publicWebsiteMock.getPublicWebsiteById.mockResolvedValue({ pages: [{ path: "/" }, { path: "/services" }] });
  prismaMock.websiteAnalyticsEvent.create.mockResolvedValue({ id: "event-1" });
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
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

describe("website analytics summary", () => {
  it("combines privacy-safe traffic with authoritative CRM website conversions", async () => {
    getAdminIdMock.mockResolvedValue("admin-1");
    prismaMock.businessWebsite.findUnique.mockResolvedValue({
      id: "website-1",
      subdomain: "bio-cleaning",
      domains: [{ domain: "www.biocleaning.co.uk" }],
    });
    prismaMock.websiteAnalyticsEvent.count.mockResolvedValueOnce(120); // page views
    prismaMock.lead.count.mockResolvedValue(17); // deduplicated CRM website leads
    prismaMock.bookingFormSubmission.count.mockResolvedValue(73);
    prismaMock.estimateFormSubmission.count.mockResolvedValue(36);
    prismaMock.websiteAnalyticsEvent.groupBy.mockResolvedValue([
      { path: "/", _count: { _all: 80 } },
      { path: "/services", _count: { _all: 40 } },
    ]);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ count: 2812n }])
      .mockResolvedValueOnce([
        { host: null, visits: 1900n },
        { host: "google.com", visits: 700n },
        { host: "www.biocleaning.co.uk", visits: 100n },
      ])
      .mockResolvedValueOnce([
        { type: "mobile", visits: 2000n },
        { type: "desktop", visits: 812n },
      ])
      .mockResolvedValueOnce([
        { serviceCatalogId: "service-1", name: "Deep Cleaning", requests: 52n, bookings: 35n, estimates: 17n },
      ]);

    const summary = await WebsiteAnalyticsService.getSummary({ id: "user-1" } as never, 30);

    expect(summary.pageViews).toBe(120);
    expect(summary.uniqueVisitors).toBe(2812);
    expect(summary.conversions).toMatchObject({
      bookings: 73,
      estimates: 36,
      contacts: 17,
      total: 126,
    });
    expect(summary.conversions.rate).toBeCloseTo((126 / 2812) * 100, 5);
    expect(summary.topServices[0]).toEqual({
      serviceCatalogId: "service-1",
      name: "Deep Cleaning",
      requests: 52,
      bookings: 35,
      estimates: 17,
    });
    expect(summary.referrers).toEqual([
      { host: "Direct", visits: 1900 },
      { host: "google.com", visits: 700 },
    ]);
    expect(summary.devices[0]).toMatchObject({ type: "mobile", visits: 2000 });
    expect(redisMock.set).toHaveBeenCalled();
  });

  it("serves a cached summary without running aggregate queries", async () => {
    getAdminIdMock.mockResolvedValue("admin-1");
    prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1", subdomain: "bio-cleaning", domains: [] });
    const cached = {
      days: 30,
      range: { from: "2026-07-19T00:00:00.000Z", to: "2026-08-17T00:00:00.000Z" },
      pageViews: 10,
      uniqueVisitors: 5,
      conversions: { contacts: 1, bookings: 2, estimates: 0, total: 3, rate: 60 },
      topPages: [],
      topServices: [],
      referrers: [],
      devices: [],
    };
    redisMock.get.mockResolvedValue(JSON.stringify(cached));

    await expect(WebsiteAnalyticsService.getSummary({ id: "user-1" } as never, 30)).resolves.toEqual(cached);
    expect(prismaMock.websiteAnalyticsEvent.count).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});
