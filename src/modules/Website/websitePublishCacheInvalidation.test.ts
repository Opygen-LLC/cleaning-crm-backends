import { beforeEach, describe, expect, it, vi } from "vitest";

type WebsiteTransactionMock = {
  businessWebsite: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  websiteRevision: { aggregate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  bookingForm: { findFirst: ReturnType<typeof vi.fn> };
  estimateForm: { findFirst: ReturnType<typeof vi.fn> };
};

const { prismaMock, txMock, hostResolverMock, projectionCacheMock } = vi.hoisted(() => {
  const tx: WebsiteTransactionMock = {
    businessWebsite: { findUnique: vi.fn(), update: vi.fn() },
    websiteRevision: { aggregate: vi.fn(), create: vi.fn() },
    bookingForm: { findFirst: vi.fn() },
    estimateForm: { findFirst: vi.fn() },
  };
  return {
    txMock: tx,
    prismaMock: {
      businessWebsite: { findUnique: vi.fn() },
      subscription: { findFirst: vi.fn(async () => ({ status: "ACTIVE", isTrial: false, subscriptionPlan: { features: [] } })) },
      $transaction: vi.fn(async (callback: (transaction: WebsiteTransactionMock) => unknown) => callback(tx)),
    },
    hostResolverMock: { invalidateSubdomains: vi.fn(), invalidateHosts: vi.fn() },
    projectionCacheMock: {
      invalidateWebsite: vi.fn(),
      invalidateStudioAdmin: vi.fn(),
    },
  };
});

vi.mock("../../config/ENV", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/ENV")>();
  return {
    ...actual,
    WEBSITE_BASE_DOMAIN: "sites.example.com",
    WEBSITE_CUSTOM_DOMAINS_ENABLED: true,
  };
});
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/prisma/advisoryLock", () => ({ acquireTextTransactionAdvisoryLock: vi.fn() }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn().mockResolvedValue("admin-1") }));
vi.mock("./templateRegistry", () => ({
  TemplateRegistry: {
    requireTemplate: vi.fn().mockReturnValue({ id: "clean-modern", version: "1.0.0", schemaVersion: 1 }),
  },
}));
vi.mock("./websiteSnapshot", () => ({ buildPublishedSnapshot: vi.fn().mockReturnValue({ website: {}, pages: [] }) }));
vi.mock("./websiteHostResolver.service", () => ({ WebsiteHostResolverService: hostResolverMock }));
vi.mock("./websiteProjectionCache.service", () => ({ WebsiteProjectionCacheService: projectionCacheMock }));
vi.mock("./websiteProvisioning.service", () => ({ WebsiteProvisioningService: {} }));

import { WebsiteService } from "./website.service";

const draft = {
  id: "website-1",
  adminId: "admin-1",
  subdomain: "sparkle",
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
  metaTitle: null,
  metaDescription: null,
  socialImageUrl: null,
  indexSite: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  publishedAt: null,
  publishedRevisionNumber: null,
  publishedSnapshot: null,
  pages: [{ id: "page-1", kind: "HOME", slug: "/", title: "Home", content: {}, isEnabled: true, showInNavigation: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() }],
  domains: [],
  assets: [],
  subdomainAliases: [],
  primaryBookingForm: null,
  primaryEstimateForm: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  draft.bookingEnabled = false;
  draft.primaryBookingFormId = null;
  prismaMock.businessWebsite.findUnique.mockResolvedValue({ id: "website-1" });
  txMock.businessWebsite.findUnique.mockResolvedValue(draft);
  txMock.businessWebsite.update.mockResolvedValue({});
  txMock.websiteRevision.aggregate
    .mockResolvedValueOnce({ _max: { revisionNumber: 0 } })
    .mockResolvedValue({ _max: { revisionNumber: 1 } });
  txMock.websiteRevision.create.mockResolvedValue({ revisionNumber: 1 });
  hostResolverMock.invalidateSubdomains.mockResolvedValue(undefined);
  hostResolverMock.invalidateHosts.mockResolvedValue(undefined);
  projectionCacheMock.invalidateWebsite.mockResolvedValue(undefined);
});

describe("website publish cache invalidation", () => {
  it("invalidates both tenant routing and the public projection after commit", async () => {
    const result = await WebsiteService.publishWebsite({}, { id: "user-1" } as never);

    expect(result.id).toBe("website-1");
    expect(txMock.businessWebsite.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "website-1" },
      data: expect.objectContaining({ status: "PUBLISHED", publishedRevisionNumber: 1 }),
    }));
    expect(hostResolverMock.invalidateSubdomains).toHaveBeenCalledWith(["sparkle"]);
    expect(hostResolverMock.invalidateHosts).toHaveBeenCalledWith([]);
    expect(projectionCacheMock.invalidateWebsite).toHaveBeenCalledWith("website-1");
  });

  it("refuses to publish when online booking is enabled without a valid Book page/form", async () => {
    draft.bookingEnabled = true;

    await expect(WebsiteService.publishWebsite({}, { id: "user-1" } as never)).rejects.toMatchObject({
      message: "Enable the Book Online page before publishing online booking",
    });
    expect(txMock.businessWebsite.update).not.toHaveBeenCalled();
  });

});
