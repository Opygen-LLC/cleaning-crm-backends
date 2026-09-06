import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultEntitlements = {
  planName: "PRO",
  basicWebsite: true,
  freeSubdomain: true,
  onlineBooking: true,
  customDomains: true,
  customDomainLimit: 3,
  premiumTemplates: true,
  analyticsHistoryDays: 365,
  advancedSeo: true,
};

type WebsiteTransactionMock = {
  businessWebsite: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  websiteRevision: { aggregate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  websitePage: { findMany: ReturnType<typeof vi.fn> };
  websiteAsset: { findFirst: ReturnType<typeof vi.fn> };
  bookingForm: { findFirst: ReturnType<typeof vi.fn> };
  estimateForm: { findFirst: ReturnType<typeof vi.fn> };
  $executeRaw: ReturnType<typeof vi.fn>;
};

const {
  prismaMock,
  txMock,
  hostResolverMock,
  projectionCacheMock,
  revalidationMock,
  publicWebsiteMock,
  entitlementMock,
  accessMock,
  deliveryOutboxMock,
  order,
} = vi.hoisted(() => {
  const events: string[] = [];
  const tx: WebsiteTransactionMock = {
    businessWebsite: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    websiteRevision: { aggregate: vi.fn(), create: vi.fn() },
    websitePage: { findMany: vi.fn() },
    websiteAsset: { findFirst: vi.fn() },
    bookingForm: { findFirst: vi.fn() },
    estimateForm: { findFirst: vi.fn() },
    $executeRaw: vi.fn(),
  };
  return {
    order: events,
    txMock: tx,
    prismaMock: {
      businessWebsite: { findUnique: vi.fn() },
      outboxEvent: { updateMany: vi.fn(async () => ({ count: 1 })) },
      $transaction: vi.fn(async (callback: (transaction: WebsiteTransactionMock) => unknown) => {
        events.push("transaction:start");
        const result = await callback(tx);
        events.push("transaction:commit");
        return result;
      }),
    },
    hostResolverMock: {
      resolveHost: vi.fn(),
      invalidateSubdomains: vi.fn(async () => { events.push("host:subdomains"); return true; }),
      invalidateHosts: vi.fn(async () => { events.push("host:hosts"); return true; }),
    },
    projectionCacheMock: {
      get: vi.fn(),
      invalidateWebsite: vi.fn(async () => { events.push("redis:public"); return { invalidated: true }; }),
      invalidateStudioAdmin: vi.fn(async () => { events.push("redis:studio"); return true; }),
    },
    accessMock: {
      invalidate: vi.fn(async () => { events.push("access:epoch"); return true; }),
      resolve: vi.fn(), isCurrentGeneration: vi.fn(async () => true),
    },
    deliveryOutboxMock: {
      enqueueDeliveryTx: vi.fn(async (_tx: unknown, payload: unknown) => {
        events.push("outbox:write"); return { id: "event-1", payload };
      }),
    },
    revalidationMock: {
      deliver: vi.fn(async () => { events.push("next:direct"); }),
      triggerWithFallback: vi.fn(async () => {
        events.push("next:direct");
        return { configured: true, delivered: true, queued: false };
      }),
    },
    publicWebsiteMock: {
      getPublicWebsiteById: vi.fn(async () => {
        events.push("projection:warm");
        return { website: { id: "website-1" } };
      }),
    },
    entitlementMock: {
      getForAdminId: vi.fn(),
      assertTemplateAllowed: vi.fn(),
    },
  };
});

vi.mock("../../config/ENV", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/ENV")>();
  return { ...actual, WEBSITE_BASE_DOMAIN: "sites.example.com", WEBSITE_CUSTOM_DOMAINS_ENABLED: true,
    NEXT_REVALIDATE_URL: "https://frontend.invalid/revalidate", NEXT_REVALIDATE_SECRET: "test-secret" };
});
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/prisma/advisoryLock", () => ({ acquireTextTransactionAdvisoryLock: vi.fn() }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn().mockResolvedValue("admin-1") }));
vi.mock("../../lib/cache/resourceCacheVersion", () => ({
  CacheResource: { website: "website" },
  bumpCacheResourceVersions: vi.fn(async () => undefined),
}));
vi.mock("./templateRegistry", () => ({
  TemplateRegistry: {
    requirePublishable: vi.fn(),
    requireTemplate: vi.fn().mockReturnValue({ id: "clean-modern", version: "1.0.0", tier: "FREE", schemaVersion: 1 }),
  },
}));
vi.mock("./websiteEntitlement.service", () => ({ WebsiteEntitlementService: entitlementMock }));
vi.mock("./websiteHostResolver.service", () => ({ WebsiteHostResolverService: hostResolverMock }));
vi.mock("./websiteProjectionCache.service", () => ({ WebsiteProjectionCacheService: projectionCacheMock }));
vi.mock("../../lib/outbox/publicWebsiteCacheOutbox", () => ({
  PublicWebsiteCacheRevalidation: revalidationMock,
  PublicWebsiteCacheOutbox: deliveryOutboxMock,
  parsePublicWebsiteCacheInvalidationPayload: (value: unknown) => value,
  publicationDeliveryDedupeKey: (id: string, revision: number) => `website-publication:${id}:${revision}`,
}));
vi.mock("../Entitlement/tenantAccessResolver.service", () => ({ TenantAccessResolver: accessMock }));
vi.mock("./publicWebsite.service", () => ({ PublicWebsiteService: publicWebsiteMock }));
vi.mock("./websiteProvisioning.service", () => ({ WebsiteProvisioningService: {} }));
vi.mock("./websiteBookingProvisioning.service", () => ({ WebsiteBookingProvisioningService: {} }));

import { WebsiteService } from "./website.service";
import { buildPublishedSnapshot } from "./websiteSnapshot";
import type { WebsiteDesignContract } from "./websiteDesignContract";

const cleanDesign = (): WebsiteDesignContract => ({
  schemaVersion: 1,
  componentOverrides: {},
  componentAnimations: {},
  sectionStyles: {},
  animationsEnabled: true,
});

const selectedDesign = (): WebsiteDesignContract => ({
  schemaVersion: 1,
  componentOverrides: {
    shared: { header: "shared.header.modern-glass.v1" },
    home: {
      hero: "home.hero.local-cleaning.v1",
      services: "home.services.compact-list.v1",
      cta: "home.cta.contact-team.v1",
    },
  },
  componentAnimations: { "home.cta": { enabled: true, effect: "fade-up", duration: "normal", delayMs: 0, trigger: "viewport", replay: false } },
  sectionStyles: { "home.cta": { backgroundColor: "#ECFDF5", textColor: "#14532D" } },
  animationsEnabled: true,
});

const draft: any = {
  id: "website-1",
  adminId: "admin-1",
  subdomain: "sparkle",
  status: "PROVISIONED",
  templateId: "clean-modern",
  templateVersion: "1.0.0",
  schemaVersion: 1,
  websiteDesign: cleanDesign(),
  primaryColor: "#0F766E",
  secondaryColor: "#0F172A",
  accentColor: "#14B8A6",
  font: null,
  logo: null,
  favicon: null,
  primaryBookingFormId: null,
  primaryEstimateFormId: null,
  bookingEnabled: false,
  bookingShowNavigation: true,
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
  metaKeywords: [],
  socialImageUrl: null,
  indexSite: true,
  googleAnalyticsEnabled: false,
  googleAnalyticsMeasurementId: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  publishedAt: null,
  draftRevisionNumber: 10,
  publishedRevisionNumber: null,
  publishedSnapshot: null,
  pages: [{
    id: "page-1", kind: "HOME", slug: "/", title: "Home", content: {}, seoTitle: null, seoDescription: null,
    seoKeywords: [], socialImageUrl: null, showInNavigation: true, isEnabled: true, sortOrder: 0,
    createdAt: new Date("2026-09-01T00:00:00.000Z"), updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  }],
  domains: [],
  assets: [],
  subdomainAliases: [],
  primaryBookingForm: null,
  primaryEstimateForm: null,
};

const resetDraft = () => {
  Object.assign(draft, {
    status: "PROVISIONED",
    templateId: "clean-modern",
    templateVersion: "1.0.0",
    schemaVersion: 1,
    websiteDesign: cleanDesign(),
    draftRevisionNumber: 10,
    publishedRevisionNumber: null,
    publishedSnapshot: null,
    publishedAt: null,
    bookingEnabled: false,
    primaryBookingFormId: null,
    primaryEstimateFormId: null,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  order.splice(0, order.length);
  resetDraft();
  entitlementMock.getForAdminId.mockResolvedValue({ ...defaultEntitlements });
  prismaMock.businessWebsite.findUnique.mockImplementation(async () => draft);
  accessMock.resolve.mockImplementation(async () => ({
    organizationId: "admin-1", generation: "epoch-1", validUntil: new Date(Date.now() + 60_000).toISOString(),
    access: { publicWebsiteAllowed: true }, website: { deniedReason: "ACTIVE" },
  }));
  hostResolverMock.resolveHost.mockImplementation(async (host: string) => ({
    websiteId: draft.id, publishedRevisionNumber: draft.publishedRevisionNumber,
    organizationId: "admin-1", accessGeneration: "epoch-1", validUntil: new Date(Date.now() + 60_000).toISOString(),
    canonicalHost: host, isAlias: false, availability: "live",
  }));
  projectionCacheMock.get.mockImplementation(async () => ({ website: { id: draft.id, publishedRevisionNumber: draft.publishedRevisionNumber } }));
  publicWebsiteMock.getPublicWebsiteById.mockImplementation(async () => {
    order.push("projection:warm");
    return { website: { id: draft.id, publishedRevisionNumber: draft.publishedRevisionNumber } };
  });
  txMock.businessWebsite.findUnique.mockImplementation(async () => draft);
  txMock.businessWebsite.findFirst.mockImplementation(async () => ({
    id: draft.id,
    status: draft.status,
    templateId: draft.templateId,
    templateVersion: draft.templateVersion,
    logo: draft.logo,
    favicon: draft.favicon,
    socialImageUrl: draft.socialImageUrl,
  }));
  txMock.businessWebsite.update.mockImplementation(async ({ data }: any) => {
    if (data.websiteDesign !== undefined) draft.websiteDesign = JSON.parse(JSON.stringify(data.websiteDesign));
    if (data.templateId !== undefined) draft.templateId = data.templateId;
    if (data.templateVersion !== undefined) draft.templateVersion = data.templateVersion;
    if (data.schemaVersion !== undefined) draft.schemaVersion = data.schemaVersion;
    if (data.draftRevisionNumber !== undefined) draft.draftRevisionNumber = data.draftRevisionNumber;
    if (data.publishedRevisionNumber !== undefined) draft.publishedRevisionNumber = data.publishedRevisionNumber;
    if (data.publishedSnapshot !== undefined) draft.publishedSnapshot = JSON.parse(JSON.stringify(data.publishedSnapshot));
    if (data.publishedAt !== undefined) draft.publishedAt = data.publishedAt;
    if (data.status !== undefined) draft.status = data.status;
    return { id: draft.id };
  });
  txMock.websiteRevision.aggregate.mockImplementation(async () => ({ _max: { revisionNumber: draft.draftRevisionNumber } }));
  txMock.websiteRevision.create.mockImplementation(async ({ data }: any) => ({ ...data, id: "revision-1" }));
  txMock.websitePage.findMany.mockResolvedValue([]);
  txMock.websiteAsset.findFirst.mockResolvedValue(null);
  txMock.bookingForm.findFirst.mockResolvedValue(null);
  txMock.estimateForm.findFirst.mockResolvedValue(null);
  txMock.$executeRaw.mockResolvedValue(0);
});

describe("Website Studio publication regression boundary", () => {
  it("save draft changes configured design only and never mutates the live publishedSnapshot", async () => {
    draft.status = "PUBLISHED";
    draft.publishedRevisionNumber = 10;
    draft.publishedAt = new Date("2026-09-01T01:00:00.000Z");
    draft.publishedSnapshot = buildPublishedSnapshot({ ...draft, websiteDesign: cleanDesign() });
    const beforeLive = JSON.parse(JSON.stringify(draft.publishedSnapshot));
    const nextDesign = selectedDesign();

    const result = await WebsiteService.saveEditorState({
      expectedRevisionNumber: 10,
      website: { websiteDesign: nextDesign },
    }, { id: "user-1" } as never);

    expect(result.draftRevisionNumber).toBe(11);
    expect(result.websiteDesign).toEqual(nextDesign);
    expect(draft.publishedSnapshot).toEqual(beforeLive);
    expect(draft.publishedSnapshot.website.websiteDesign).toEqual(cleanDesign());
    expect(draft.publishedRevisionNumber).toBe(10);
    expect(projectionCacheMock.invalidateStudioAdmin).toHaveBeenCalledWith("admin-1");
    expect(projectionCacheMock.invalidateWebsite).not.toHaveBeenCalled();
    expect(hostResolverMock.invalidateSubdomains).not.toHaveBeenCalled();
    expect(hostResolverMock.invalidateHosts).not.toHaveBeenCalled();
    expect(revalidationMock.triggerWithFallback).not.toHaveBeenCalled();
  });

  it("publishes the exact latest configured design and snapshots it immutably", async () => {
    draft.websiteDesign = selectedDesign();

    const result = await WebsiteService.publishWebsite({ expectedRevisionNumber: 10 }, { id: "user-1" } as never);

    expect(result.publishedRevisionNumber).toBe(11);
    expect(draft.publishedSnapshot).toMatchObject({
      version: 1,
      website: { templateId: "clean-modern", websiteDesign: selectedDesign() },
    });
    expect(result.publishedWebsiteDesign).toEqual(selectedDesign());
  });

  it("commits the publication transaction before Redis/routing invalidation and direct Next revalidation", async () => {
    draft.websiteDesign = selectedDesign();

    await WebsiteService.publishWebsite({ expectedRevisionNumber: 10 }, { id: "user-1" } as never);

    const commit = order.indexOf("transaction:commit");
    const subdomain = order.indexOf("host:subdomains");
    const hosts = order.indexOf("host:hosts");
    const redis = order.indexOf("redis:public");
    const next = order.indexOf("next:direct");
    const warm = order.indexOf("projection:warm");
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("outbox:write")).toBeLessThan(commit);
    expect(order.indexOf("access:epoch")).toBeGreaterThan(commit);
    expect(subdomain).toBeGreaterThan(order.indexOf("access:epoch"));
    expect(redis).toBeGreaterThan(order.indexOf("access:epoch"));
    expect(subdomain).toBeGreaterThan(commit);
    expect(hosts).toBeGreaterThan(commit);
    expect(redis).toBeGreaterThan(commit);
    expect(next).toBeGreaterThan(subdomain);
    expect(next).toBeGreaterThan(hosts);
    expect(next).toBeGreaterThan(redis);
    expect(warm).toBeGreaterThan(next);

    expect(projectionCacheMock.invalidateWebsite).toHaveBeenCalledWith(
      "website-1",
      "admin-1",
      expect.objectContaining({ revalidateNext: false, reason: "website-published" }),
    );
    expect(revalidationMock.deliver).toHaveBeenCalledWith(expect.objectContaining({
      websiteId: "website-1",
      tenantIdentifier: "sparkle",
      tenantIdentifiers: ["sparkle"],
      reason: "website-published",
    }));
  });

  it("a draft conflict changes nothing public and returns both revision numbers", async () => {
    await expect(WebsiteService.saveEditorState({
      expectedRevisionNumber: 9,
      website: { websiteDesign: selectedDesign() },
    }, { id: "user-1" } as never)).rejects.toMatchObject({
      name: "WebsiteDraftConflictError",
      code: "WEBSITE_DRAFT_CONFLICT",
      retryable: false,
      expectedRevisionNumber: 9,
      currentRevisionNumber: 10,
    });

    expect(draft.websiteDesign).toEqual(cleanDesign());
    expect(draft.publishedSnapshot).toBeNull();
    expect(projectionCacheMock.invalidateWebsite).not.toHaveBeenCalled();
    expect(projectionCacheMock.invalidateStudioAdmin).not.toHaveBeenCalled();
    expect(hostResolverMock.invalidateSubdomains).not.toHaveBeenCalled();
    expect(revalidationMock.triggerWithFallback).not.toHaveBeenCalled();
  });

  it("re-checks premium component entitlement immediately before snapshotting", async () => {
    entitlementMock.getForAdminId.mockResolvedValue({ ...defaultEntitlements, premiumTemplates: false });
    draft.websiteDesign = {
      ...cleanDesign(),
      componentOverrides: { shared: { header: "shared.header.modern-glass.v1" } },
    };

    await expect(WebsiteService.publishWebsite({ expectedRevisionNumber: 10 }, { id: "user-1" } as never)).rejects.toMatchObject({
      statusCode: 403,
      code: "WEBSITE_PREMIUM_COMPONENT_REQUIRED",
      retryable: false,
    });

    expect(txMock.websiteRevision.create).not.toHaveBeenCalled();
    expect(draft.publishedSnapshot).toBeNull();
    expect(projectionCacheMock.invalidateWebsite).not.toHaveBeenCalled();
    expect(revalidationMock.triggerWithFallback).not.toHaveBeenCalled();
  });

  it("refuses to publish when online booking is enabled without a valid Book page/form", async () => {
    draft.bookingEnabled = true;

    await expect(WebsiteService.publishWebsite({ expectedRevisionNumber: 10 }, { id: "user-1" } as never)).rejects.toMatchObject({
      message: "Enable the Book Online page before publishing online booking",
    });
    expect(txMock.websiteRevision.create).not.toHaveBeenCalled();
    draft.bookingEnabled = false;
  });
});
