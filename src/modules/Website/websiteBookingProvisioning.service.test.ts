import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, txMock, cacheMock } = vi.hoisted(() => {
  const tx = {
    adminProfile: { findUnique: vi.fn() },
    serviceCatalog: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    bookingForm: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    bookingFormService: { deleteMany: vi.fn(), createMany: vi.fn() },
    businessWebsite: { update: vi.fn() },
  };
  return {
    txMock: tx,
    prismaMock: {
      businessWebsite: { findUnique: vi.fn() },
      bookingForm: { findMany: vi.fn() },
      serviceCatalog: { count: vi.fn() },
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    },
    cacheMock: { invalidateAdminWebsite: vi.fn() },
  };
});

vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireExtendedTextTransactionAdvisoryLock: vi.fn(),
}));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn().mockResolvedValue("admin-1") }));
vi.mock("./websiteProjectionCache.service", () => ({ WebsiteProjectionCacheService: cacheMock }));

import { WebsiteBookingProvisioningService } from "./websiteBookingProvisioning.service";

const admin = {
  id: "admin-1",
  businessName: "Bio Cleaning",
  businessWebsite: {
    id: "website-1",
    status: "PROVISIONED",
    accentColor: "#14B8A6",
    primaryBookingFormId: null,
  },
};

const service = {
  id: "service-1",
  duration: "2h",
  legacyServiceType: "RESIDENTIAL_CLEAN",
};

beforeEach(() => {
  vi.clearAllMocks();
  txMock.adminProfile.findUnique.mockResolvedValue(admin);
  txMock.serviceCatalog.findMany.mockResolvedValue([service]);
  txMock.bookingForm.findMany.mockResolvedValue([]);
  txMock.bookingForm.findFirst.mockResolvedValue(null);
  txMock.bookingForm.update.mockResolvedValue({});
  txMock.bookingForm.create.mockResolvedValue({
    id: "form-1",
    headline: "Bio Cleaning Online Booking",
    slug: "bio-cleaning-online-booking-admin1",
    published: true,
    websiteManaged: true,
  });
  txMock.bookingFormService.deleteMany.mockResolvedValue({ count: 0 });
  txMock.bookingFormService.createMany.mockResolvedValue({ count: 1 });
  txMock.businessWebsite.update.mockResolvedValue({});
  prismaMock.businessWebsite.findUnique.mockResolvedValue({
    primaryBookingFormId: "form-1",
    primaryBookingForm: {
      id: "form-1",
      headline: "Bio Cleaning Online Booking",
      slug: "bio-cleaning-online-booking-admin1",
      published: true,
      websiteManaged: true,
    },
  });
  prismaMock.bookingForm.findMany.mockResolvedValue([
    {
      id: "form-1",
      headline: "Bio Cleaning Online Booking",
      slug: "bio-cleaning-online-booking-admin1",
      published: true,
      websiteManaged: true,
      updatedAt: new Date(),
      createdAt: new Date(),
    },
  ]);
  prismaMock.serviceCatalog.count.mockResolvedValue(1);
  cacheMock.invalidateAdminWebsite.mockResolvedValue(undefined);
});

describe("WebsiteBookingProvisioningService", () => {
  it("creates and publishes a website-managed BookingForm when none exists", async () => {
    const result = await WebsiteBookingProvisioningService.configure(
      { enabled: true },
      { id: "user-1" } as never,
    );

    expect(txMock.bookingForm.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        published: true,
        websiteManaged: true,
        headline: "Bio Cleaning Online Booking",
      }),
    }));
    expect(txMock.bookingFormService.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ formId: "form-1", serviceCatalogId: "service-1", enabled: true })],
    });
    expect(txMock.businessWebsite.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "website-1" },
      data: expect.objectContaining({ primaryBookingFormId: "form-1", status: "DRAFT" }),
    }));
    expect(result.enabled).toBe(true);
    expect(result.primaryBookingFormId).toBe("form-1");
  });

  it("automatically attaches the only published BookingForm for an existing customer", async () => {
    txMock.bookingForm.findMany.mockResolvedValue([
      { id: "existing-form", websiteManaged: false },
    ]);

    await WebsiteBookingProvisioningService.configure(
      { enabled: true },
      { id: "user-1" } as never,
    );

    expect(txMock.bookingForm.create).not.toHaveBeenCalled();
    expect(txMock.businessWebsite.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ primaryBookingFormId: "existing-form" }),
    }));
  });

  it("requires an explicit choice when several published forms exist", async () => {
    txMock.bookingForm.findMany.mockResolvedValue([
      { id: "form-a", websiteManaged: false },
      { id: "form-b", websiteManaged: false },
    ]);

    await expect(
      WebsiteBookingProvisioningService.configure({ enabled: true }, { id: "user-1" } as never),
    ).rejects.toMatchObject({ code: "BOOKING_FORM_SELECTION_REQUIRED", statusCode: 409 });

    expect(txMock.bookingForm.create).not.toHaveBeenCalled();
    expect(txMock.businessWebsite.update).not.toHaveBeenCalled();
  });
});
