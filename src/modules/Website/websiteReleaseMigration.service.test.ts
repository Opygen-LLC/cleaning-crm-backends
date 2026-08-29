import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  provision: vi.fn(),
  templateGet: vi.fn(() => ({ id: "clean-modern", version: "1.0.0", schemaVersion: 1 })),
  templateRequire: vi.fn(() => ({ id: "clean-modern", version: "1.0.0", schemaVersion: 1 })),
  validateContent: vi.fn((_kind: string, content: unknown) => content),
  buildPublished: vi.fn((draft: any) => ({ version: 1, website: draft, pages: draft.pages })),
  parsePublished: vi.fn(),
  parseRevision: vi.fn(),
  invalidateSubdomains: vi.fn(),
  invalidateWebsite: vi.fn(),
}));

vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireTextTransactionAdvisoryLock: mocks.acquireLock,
}));
vi.mock("../../lib/prisma/prisma", () => ({
  prisma: { $transaction: vi.fn() },
}));
vi.mock("./websiteProvisioning.service", () => ({
  WebsiteProvisioningService: { provisionDefaultWebsiteForAdminTx: mocks.provision },
}));
vi.mock("./templateRegistry", () => ({
  TemplateRegistry: { get: mocks.templateGet, requireTemplate: mocks.templateRequire },
}));
vi.mock("./websiteContent", () => ({ validateWebsitePageContent: mocks.validateContent }));
vi.mock("./websiteSnapshot", () => ({
  buildPublishedSnapshot: mocks.buildPublished,
  parsePublishedSnapshot: mocks.parsePublished,
  parseRevisionSnapshotAsPublished: mocks.parseRevision,
}));
vi.mock("./websiteHostResolver.service", () => ({
  WebsiteHostResolverService: { invalidateSubdomains: mocks.invalidateSubdomains },
}));
vi.mock("./websiteProjectionCache.service", () => ({
  WebsiteProjectionCacheService: { invalidateWebsite: mocks.invalidateWebsite },
}));

import { DEFAULT_WEBSITE_PAGES } from "./website.constant";
import { WebsiteReleaseMigrationService } from "./websiteReleaseMigration.service";

const template = { id: "clean-modern", version: "1.0.0", schemaVersion: 1 };
const input = { adminId: "admin-1", userId: "user-1", businessName: "Sparkle Cleaning" };

const pages = () => DEFAULT_WEBSITE_PAGES.map((page, index) => ({
  id: `page-${index}`,
  websiteId: "website-1",
  ...page,
  isEnabled: "isEnabled" in page ? page.isEnabled : true,
  seoTitle: null,
  seoDescription: null,
  createdAt: new Date("2026-08-18T00:00:00Z"),
  updatedAt: new Date("2026-08-18T00:00:00Z"),
}));

const website = (overrides: Record<string, unknown> = {}) => ({
  id: "website-1",
  adminId: "admin-1",
  subdomain: "sparkle-cleaning",
  status: "PROVISIONED",
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
  bookingEnabled: false,
  bookingShowHeaderCta: true,
  bookingShowServiceCtas: true,
  bookingShowHomeCta: true,
  bookingShowAvailableSlots: true,
  bookingShowPrices: true,
  bookingShowStartingPrices: true,
  bookingShowServiceDuration: true,
  bookingCtaLabel: "Book Now",
  estimateEnabled: false,
  metaTitle: null,
  metaDescription: null,
  socialImageUrl: null,
  indexSite: true,
  publishedAt: null,
  publishedSnapshot: null,
  publishedRevisionNumber: null,
  createdAt: new Date("2026-08-18T00:00:00Z"),
  updatedAt: new Date("2026-08-18T00:00:00Z"),
  pages: pages(),
  revisions: [{ id: "rev-1", revisionNumber: 1, snapshot: {} }],
  ...overrides,
});

const tx = () => ({
  businessWebsite: { findUnique: vi.fn(), update: vi.fn() },
  websitePage: { create: vi.fn() },
  websiteRevision: { create: vi.fn() },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.templateRequire.mockReturnValue(template);
  mocks.templateGet.mockReturnValue(template);
  mocks.provision.mockResolvedValue({ created: false, website: { id: "website-1", subdomain: "sparkle-cleaning" } });
});

describe("Phase 10 website structural repair", () => {
  it("provisions a missing legacy customer website through the canonical provisioner", async () => {
    const db = tx();
    mocks.provision.mockResolvedValueOnce({
      created: true,
      website: { id: "website-new", subdomain: "sparkle-cleaning" },
    });

    const result = await WebsiteReleaseMigrationService.reconcileAdminWebsiteTx(db as never, input);

    expect(mocks.provision).toHaveBeenCalledWith(db, expect.objectContaining({
      adminId: "admin-1",
      businessName: "Sparkle Cleaning",
      createdByUserId: "user-1",
    }));
    expect(result).toMatchObject({
      websiteId: "website-new",
      healthy: true,
      created: true,
      repaired: true,
      detectedIssues: ["MISSING_WEBSITE"],
      actions: ["WEBSITE_PROVISIONED"],
    });
    expect(db.businessWebsite.update).not.toHaveBeenCalled();
  });

  it("is a no-op for a healthy unpublished tenant", async () => {
    const db = tx();
    db.businessWebsite.findUnique.mockResolvedValue(website());

    const result = await WebsiteReleaseMigrationService.reconcileAdminWebsiteTx(db as never, input);

    expect(result).toMatchObject({ healthy: true, created: false, repaired: false, actions: [] });
    expect(db.websitePage.create).not.toHaveBeenCalled();
    expect(db.websiteRevision.create).not.toHaveBeenCalled();
    expect(db.businessWebsite.update).not.toHaveBeenCalled();
  });

  it("adds a missing system page and revision without publishing the tenant", async () => {
    const db = tx();
    const missingBook = website({
      pages: pages().filter((page) => page.kind !== "BOOK"),
      revisions: [],
    });
    const repaired = website({ revisions: [{ id: "rev-1", revisionNumber: 1, snapshot: {} }] });
    db.businessWebsite.findUnique
      .mockResolvedValueOnce(missingBook)
      .mockResolvedValueOnce({ ...missingBook, pages: pages(), revisions: [] })
      .mockResolvedValueOnce(repaired);

    const result = await WebsiteReleaseMigrationService.reconcileAdminWebsiteTx(db as never, input);

    expect(db.websitePage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ websiteId: "website-1", kind: "BOOK", isEnabled: false }),
    }));
    expect(db.websiteRevision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ revisionNumber: 1, reason: "Phase 10 release baseline repair" }),
    }));
    expect(db.businessWebsite.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PUBLISHED" }),
    }));
    expect(result.actions).toEqual(expect.arrayContaining(["SYSTEM_PAGE_CREATED", "INITIAL_REVISION_CREATED"]));
  });

  it("preserves a valid live snapshot when only published metadata is missing", async () => {
    const db = tx();
    const liveSnapshot = {
      version: 1,
      website: { templateId: "clean-modern", templateVersion: "1.0.0", schemaVersion: 1 },
      pages: [{ id: "live-home", kind: "HOME", content: { heroTitle: "LIVE COPY" } }],
    };
    const before = website({
      status: "PUBLISHED",
      publishedAt: null,
      publishedRevisionNumber: null,
      publishedSnapshot: liveSnapshot,
      pages: pages(),
      revisions: [{ id: "rev-1", revisionNumber: 1, snapshot: { heroTitle: "LIVE COPY" } }],
    });
    const after = website({
      status: "PUBLISHED",
      publishedAt: new Date("2026-08-18T00:00:00Z"),
      publishedRevisionNumber: 1,
      publishedSnapshot: liveSnapshot,
      pages: pages(),
      revisions: [{ id: "rev-1", revisionNumber: 1, snapshot: { heroTitle: "LIVE COPY" } }],
    });
    db.businessWebsite.findUnique
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    mocks.parsePublished.mockImplementation((value) => value === liveSnapshot ? liveSnapshot : value);
    mocks.parseRevision.mockReturnValue(liveSnapshot);

    await WebsiteReleaseMigrationService.reconcileAdminWebsiteTx(db as never, input);

    expect(mocks.buildPublished).not.toHaveBeenCalled();
    expect(db.businessWebsite.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "website-1" },
      data: expect.objectContaining({ publishedSnapshot: liveSnapshot, publishedRevisionNumber: 1 }),
    }));
  });
});
