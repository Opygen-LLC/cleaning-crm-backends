import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  failBooking: true,
  state: {
    services: ["Legacy Cleaning"],
    bookingEnabled: false,
    completedSteps: ["business_profile", "branding"],
    revisionReason: null as string | null,
  },
  serviceSyncCalls: 0,
  bookingCalls: 0,
}));

const restore = (snapshot: typeof harness.state) => {
  harness.state.services = [...snapshot.services];
  harness.state.bookingEnabled = snapshot.bookingEnabled;
  harness.state.completedSteps = [...snapshot.completedSteps];
  harness.state.revisionReason = snapshot.revisionReason;
};

const tx = {
  adminProfile: {
    findUnique: vi.fn(async (args: { where: { userId?: string; id?: string } }) => {
      if (args.where.userId || args.where.id) {
        return {
          id: "admin-1",
          businessName: "Atomic Cleaning",
          onboardingCompletedAt: null,
          onboardingCompletedSteps: [...harness.state.completedSteps],
          businessWebsite: { id: "website-1" },
        };
      }
      return null;
    }),
    update: vi.fn(async (args: { data: { onboardingCompletedSteps?: string[] } }) => {
      if (args.data.onboardingCompletedSteps) {
        harness.state.completedSteps = [...args.data.onboardingCompletedSteps];
      }
      return {};
    }),
  },
  websiteRevision: {
    findFirst: vi.fn(async () => harness.state.revisionReason
      ? { reason: harness.state.revisionReason }
      : null),
  },
};

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      const snapshot = structuredClone(harness.state);
      try {
        return await callback(tx);
      } catch (error) {
        restore(snapshot);
        throw error;
      }
    }),
    adminProfile: {
      findUnique: vi.fn(async () => ({
        id: "admin-1",
        updatedAt: new Date("2026-08-29T00:00:00.000Z"),
        onboardingCompletedAt: null,
        onboardingCompletedSteps: [...harness.state.completedSteps],
        businessWebsite: {
          status: "DRAFT",
          subdomain: "atomic-cleaning",
          publishedAt: null,
          updatedAt: new Date("2026-08-29T00:00:01.000Z"),
        },
      })),
    },
    serviceCatalog: {
      findMany: vi.fn(async () => harness.state.services.map((serviceName, index) => ({
        id: `service-${index + 1}`,
        serviceName,
        description: "Test service",
        basePrice: 75,
        duration: "2h",
        category: "RESIDENTIAL",
        status: "ACTIVE",
        onlineBookingEnabled: true,
        addOns: [],
      }))),
      findFirst: vi.fn(async () => ({ id: "service-1" })),
    },
    $queryRaw: vi.fn(async () => []),
  },
}));

vi.mock("../ServiceCatalog/serviceCatalog.service", () => ({
  invalidateServiceCatalogReadModels: vi.fn(async () => undefined),
  syncServiceCatalogSelectionTx: vi.fn(async (_tx: unknown, _adminId: string, services: Array<{ serviceName: string }>) => {
    harness.serviceSyncCalls += 1;
    harness.state.services = services.map((service: { serviceName: string }) => service.serviceName);
    return services.map((service: { serviceName: string }, index: number) => ({ id: `service-${index + 1}`, ...service }));
  }),
}));

vi.mock("../Website/websiteBookingProvisioning.service", () => ({
  WebsiteBookingProvisioningService: {
    configureForAdminTx: vi.fn(async (_tx: unknown, _adminId: string, booking: { enabled: boolean }) => {
      harness.bookingCalls += 1;
      harness.state.bookingEnabled = booking.enabled;
      if (harness.failBooking) throw new Error("injected booking configuration failure");
      return { websiteId: "website-1", primaryBookingFormId: booking.enabled ? "form-1" : null };
    }),
    getSetupByAdminId: vi.fn(async () => ({
      enabled: harness.state.bookingEnabled,
      live: false,
      primaryBookingFormId: harness.state.bookingEnabled ? "form-1" : null,
      primaryBookingForm: harness.state.bookingEnabled
        ? { id: "form-1", headline: "Book", slug: "book", published: true, websiteManaged: true }
        : null,
      publishedForms: harness.state.bookingEnabled
        ? [{ id: "form-1", headline: "Book", slug: "book", published: true, websiteManaged: true }]
        : [],
      publishedFormCount: harness.state.bookingEnabled ? 1 : 0,
      bookableServiceCount: harness.state.services.length,
      requiresSelection: false,
      canCreateDefault: !harness.state.bookingEnabled,
      websitePath: "/book",
      estimate: {
        enabled: false, live: false, primaryEstimateFormId: null, primaryEstimateForm: null,
        publishedForms: [], websitePath: "/estimate",
      },
      settings: {
        showNavigation: true, showHeaderCta: true, showServiceCtas: true, showHomeCta: true,
        showAvailableSlots: false, showPrices: true, showStartingPrices: true,
        showServiceDuration: true, ctaLabel: "Book Now",
      },
    })),
  },
}));

vi.mock("../Website/website.service", () => ({
  WebsiteService: {
    ensurePublishedSnapshotBeforeDraftMutationTx: vi.fn(async () => undefined),
    createRevisionSnapshotTx: vi.fn(async (_tx: unknown, _websiteId: string, _userId: string, reason: string) => {
      harness.state.revisionReason = reason;
      return {};
    }),
    getWebsiteForAdmin: vi.fn(async () => ({
      id: "website-1",
      status: "DRAFT",
      subdomain: "atomic-cleaning",
      publicUrl: "https://atomic-cleaning.cleaningcrm.opygen.com",
      draftRevisionNumber: harness.state.revisionReason ? 2 : 1,
      publishedRevisionNumber: null,
      bookingEnabled: harness.state.bookingEnabled,
      primaryBookingFormId: harness.state.bookingEnabled ? "form-1" : null,
      bookingShowPrices: true,
      bookingShowServiceDuration: true,
      bookingShowAvailableSlots: false,
      bookingCtaLabel: "Book Now",
    })),
  },
}));

vi.mock("../Website/websiteProjectionCache.service", () => ({
  WebsiteProjectionCacheService: { invalidateAdminWebsite: vi.fn(async () => undefined) },
}));
vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireExtendedTextTransactionAdvisoryLock: vi.fn(async () => undefined),
  acquireTextTransactionAdvisoryLock: vi.fn(async () => undefined),
}));
vi.mock("../../config/redis", () => ({ default: { get: vi.fn(), setex: vi.fn(), del: vi.fn(async () => 1) } }));
vi.mock("../../lib/monitoring/errorMonitor", () => ({ ErrorMonitor: { captureDashboardClientError: vi.fn(async () => undefined) } }));

import { adminService } from "./admin.service";

const payload = {
  services: [{
    serviceName: "Standard Cleaning",
    description: "Routine cleaning",
    basePrice: 75,
    duration: "2h",
    category: "RESIDENTIAL" as const,
    onlineBookingEnabled: true,
    addOns: [],
  }],
  booking: {
    enabled: true,
    bookingFormId: null,
    showNavigation: true,
    showHeaderCta: true,
    showServiceCtas: true,
    showHomeCta: true,
    showAvailableSlots: false,
    showPrices: true,
    showStartingPrices: true,
    showServiceDuration: true,
    ctaLabel: "Book Now",
  },
};

beforeEach(() => {
  harness.failBooking = true;
  harness.state.services = ["Legacy Cleaning"];
  harness.state.bookingEnabled = false;
  harness.state.completedSteps = ["business_profile", "branding"];
  harness.state.revisionReason = null;
  harness.serviceSyncCalls = 0;
  harness.bookingCalls = 0;
  vi.clearAllMocks();
});

describe("atomic onboarding services transaction", () => {
  it("rolls back every resource when booking setup fails after service synchronization, then commits on retry", async () => {
    await expect(adminService.saveOnboardingServices("user-1", payload, {
      requestId: "req-failure",
      traceId: "0123456789abcdef0123456789abcdef",
    })).rejects.toThrow(/injected booking configuration failure/);

    expect(harness.state).toEqual({
      services: ["Legacy Cleaning"],
      bookingEnabled: false,
      completedSteps: ["business_profile", "branding"],
      revisionReason: null,
    });

    harness.failBooking = false;
    const committed = await adminService.saveOnboardingServices("user-1", payload, {
      requestId: "req-retry",
      traceId: "fedcba9876543210fedcba9876543210",
    });

    expect(harness.state.services).toEqual(["Standard Cleaning"]);
    expect(harness.state.bookingEnabled).toBe(true);
    expect(harness.state.completedSteps).toContain("services");
    expect(harness.state.revisionReason).toMatch(/^Onboarding services:/);
    expect(committed).toMatchObject({
      schemaVersion: 1,
      nextStep: "website_address",
      websiteDraft: { bookingEnabled: true, primaryBookingFormId: "form-1" },
    });
  });

  it("treats an identical successful retry as read-only and does not duplicate service/booking mutations", async () => {
    harness.failBooking = false;
    await adminService.saveOnboardingServices("user-1", payload);
    const firstServiceSyncCalls = harness.serviceSyncCalls;
    const firstBookingCalls = harness.bookingCalls;
    const firstRevision = harness.state.revisionReason;

    await adminService.saveOnboardingServices("user-1", payload);

    expect(harness.serviceSyncCalls).toBe(firstServiceSyncCalls);
    expect(harness.bookingCalls).toBe(firstBookingCalls);
    expect(harness.state.revisionReason).toBe(firstRevision);
  });
});
