import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  txMock,
  hostResolverMock,
  projectionCacheMock,
  publicWebsiteMock,
  bookingProvisioningMock,
  loggerMock,
  state,
  owner,
  revisionState,
} = vi.hoisted(() => {
  const state: any = {
    id: "website-1",
    adminId: "admin-1",
    subdomain: "bio-cleaning",
    status: "DRAFT",
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
    bookingEnabled: true,
    bookingShowHeaderCta: true,
    bookingShowServiceCtas: true,
    bookingShowHomeCta: true,
    bookingShowAvailableSlots: true,
    bookingShowPrices: true,
    metaTitle: null,
    metaDescription: null,
    socialImageUrl: null,
    indexSite: true,
    createdAt: new Date("2026-08-17T10:00:00Z"),
    updatedAt: new Date("2026-08-17T10:00:00Z"),
    publishedAt: null,
    publishedSnapshot: null,
    publishedRevisionNumber: null,
    draftRevisionNumber: 5,
    pages: [
      { id: "home", kind: "HOME", slug: "/", title: "Home", content: {}, seoTitle: null, seoDescription: null, showInNavigation: true, isEnabled: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
      { id: "book", kind: "BOOK", slug: "/book", title: "Book Online", content: {}, seoTitle: null, seoDescription: null, showInNavigation: true, isEnabled: true, sortOrder: 5, createdAt: new Date(), updatedAt: new Date() },
    ],
    domains: [],
    assets: [],
    subdomainAliases: [],
    primaryBookingForm: null,
    primaryEstimateForm: null,
  };

  const owner: any = {
    id: "admin-1",
    businessName: "Bio Cleaning",
    businessEmail: "hello@biocleaning.example",
    onboardingCompletedAt: null,
    onboardingCompletedSteps: ["business_profile", "services", "branding", "website_address", "review_launch"],
    user: { email: "owner@biocleaning.example", status: "ACTIVE" },
    businessWebsite: {
      id: "website-1",
      subdomain: "bio-cleaning",
      status: "DRAFT",
      publishedAt: null,
      publishedSnapshot: null,
      publishedRevisionNumber: null,
    },
  };

  const revisionState = { latest: 5 };
  const tx: any = {
    adminProfile: {
      findUnique: vi.fn(async () => owner),
      update: vi.fn(async ({ data }: any) => {
        if (data.onboardingCompletedAt) owner.onboardingCompletedAt = data.onboardingCompletedAt;
        return owner;
      }),
    },
    businessWebsite: {
      findUnique: vi.fn(async () => state),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(state, data);
        Object.assign(owner.businessWebsite, {
          status: state.status,
          publishedAt: state.publishedAt,
          publishedSnapshot: state.publishedSnapshot,
          publishedRevisionNumber: state.publishedRevisionNumber,
        });
        return state;
      }),
    },
    websiteSubdomainAlias: { findFirst: vi.fn(async () => null) },
    websiteRevision: {
      aggregate: vi.fn(async () => ({ _max: { revisionNumber: revisionState.latest } })),
      create: vi.fn(async ({ data }: any) => {
        revisionState.latest = data.revisionNumber;
        return { ...data, id: `revision-${revisionState.latest}` };
      }),
    },
    bookingForm: { findFirst: vi.fn(async () => ({ id: "form-1" })) },
    estimateForm: { findFirst: vi.fn(async () => null) },
  };

  return {
    state,
    owner,
    revisionState,
    txMock: tx,
    prismaMock: {
      businessWebsite: { findUnique: vi.fn(async () => ({ id: "website-1" })) },
      subscription: { findFirst: vi.fn(async () => ({ status: "ACTIVE", isTrial: false, subscriptionPlan: { features: [] } })) },
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    },
    hostResolverMock: {
      invalidateSubdomains: vi.fn(async () => undefined),
      invalidateHosts: vi.fn(async () => undefined),
    },
    projectionCacheMock: {
      invalidateWebsite: vi.fn(async () => undefined),
      invalidateStudioAdmin: vi.fn(async () => undefined),
    },
    publicWebsiteMock: { getPublicWebsiteById: vi.fn(async () => ({ website: { subdomain: "bio-cleaning" } })) },
    bookingProvisioningMock: {
      ensureAttachedForLaunchTx: vi.fn(async (transaction: any) => {
        await transaction.businessWebsite.update({ where: { id: "website-1" }, data: { primaryBookingFormId: "form-1" } });
        return "form-1";
      }),
    },
    loggerMock: { warn: vi.fn() },
  };
});

vi.mock("../../config/ENV", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/ENV")>();
  return {
    ...actual,
    WEBSITE_BASE_DOMAIN: "sites.example.com",
    WEBSITE_CUSTOM_DOMAINS_ENABLED: false,
  };
});
vi.mock("../../lib/logger", () => ({ default: loggerMock }));
vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/prisma/advisoryLock", () => ({ acquireTextTransactionAdvisoryLock: vi.fn() }));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn().mockResolvedValue("admin-1") }));
vi.mock("../../lib/utils/cloudinary", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("../Admin/admin.constant", () => ({
  ONBOARDING_STEPS: [
    { key: "business_profile" },
    { key: "services" },
    { key: "branding" },
    { key: "website_address" },
    { key: "template" },
  ],
}));
vi.mock("./websiteIdentity", () => ({
  normalizeSubdomain: (value: string) => value.trim().toLowerCase(),
  assertSafeHttpsUrl: (value: unknown) => value,
}));
vi.mock("./templateRegistry", () => ({
  TemplateRegistry: { requireTemplate: vi.fn(() => ({ id: "clean-modern", version: "1.0.0", schemaVersion: 1 })) },
}));
vi.mock("./websiteProvisioning.service", () => ({ WebsiteProvisioningService: {} }));
vi.mock("./websiteBookingProvisioning.service", () => ({ WebsiteBookingProvisioningService: bookingProvisioningMock }));
vi.mock("./publicWebsite.service", () => ({ PublicWebsiteService: publicWebsiteMock }));
vi.mock("./websiteSnapshot", () => ({
  buildPublishedSnapshot: vi.fn((draft: any) => ({
    version: 1,
    website: { primaryBookingFormId: draft.primaryBookingFormId, bookingEnabled: draft.bookingEnabled },
    pages: draft.pages,
  })),
}));
vi.mock("./websiteHostResolver.service", () => ({ WebsiteHostResolverService: hostResolverMock }));
vi.mock("./websiteProjectionCache.service", () => ({ WebsiteProjectionCacheService: projectionCacheMock }));
vi.mock("./websiteDomainReadiness", () => ({ isWebsiteDomainRoutingReady: vi.fn(() => false) }));

import { WebsiteService } from "./website.service";

beforeEach(() => {
  vi.clearAllMocks();
  state.status = "DRAFT";
  state.primaryBookingFormId = null;
  state.bookingEnabled = true;
  state.publishedAt = null;
  state.publishedSnapshot = null;
  state.publishedRevisionNumber = null;
  owner.onboardingCompletedAt = null;
  owner.businessWebsite.status = "DRAFT";
  owner.businessWebsite.publishedAt = null;
  owner.businessWebsite.publishedSnapshot = null;
  owner.businessWebsite.publishedRevisionNumber = null;
  revisionState.latest = 5;
  state.draftRevisionNumber = 5;
});

describe("first website launch", () => {
  it("publishes booking + snapshot + revision + onboarding in one transaction", async () => {
    const result = await WebsiteService.launchWebsite({}, { id: "user-1" } as never);

    expect(bookingProvisioningMock.ensureAttachedForLaunchTx).toHaveBeenCalledWith(
      txMock,
      "admin-1",
      "website-1",
      expect.objectContaining({
        id: "admin-1",
        businessName: "Bio Cleaning",
        businessWebsite: expect.objectContaining({ id: "website-1" }),
      }),
    );
    expect(txMock.websiteRevision.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reason: "Website launched", revisionNumber: 6 }),
    }));
    expect(txMock.businessWebsite.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PUBLISHED", publishedRevisionNumber: 6 }),
    }));
    expect(txMock.adminProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { onboardingCompletedAt: expect.any(Date) },
    }));
    expect(result.businessName).toBe("Bio Cleaning");
    expect(result.publicUrl).toBe("https://bio-cleaning.sites.example.com");
    expect(hostResolverMock.invalidateSubdomains).toHaveBeenCalledWith(["bio-cleaning"]);
    expect(hostResolverMock.invalidateHosts).toHaveBeenCalledWith([]);
    expect(projectionCacheMock.invalidateWebsite).toHaveBeenCalledWith("website-1");
    expect(publicWebsiteMock.getPublicWebsiteById).toHaveBeenCalledWith("website-1");
  });

  it("is retry-safe after the first launch committed", async () => {
    await WebsiteService.launchWebsite({}, { id: "user-1" } as never);
    const revisionCalls = txMock.websiteRevision.create.mock.calls.length;
    const bookingCalls = bookingProvisioningMock.ensureAttachedForLaunchTx.mock.calls.length;

    const retry = await WebsiteService.launchWebsite({}, { id: "user-1" } as never);

    expect(retry.alreadyLive).toBe(true);
    expect(txMock.websiteRevision.create).toHaveBeenCalledTimes(revisionCalls);
    expect(bookingProvisioningMock.ensureAttachedForLaunchTx).toHaveBeenCalledTimes(bookingCalls);
  });
  it("launches without provisioning a BookingForm when website booking is disabled", async () => {
    state.bookingEnabled = false;

    const result = await WebsiteService.launchWebsite({}, { id: "user-1" } as never);

    expect(bookingProvisioningMock.ensureAttachedForLaunchTx).not.toHaveBeenCalled();
    expect(result.publicUrl).toBe("https://bio-cleaning.sites.example.com");
    expect(txMock.businessWebsite.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PUBLISHED" }),
    }));
  });

});
