import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  publicWebsiteMock,
  bookingFormMock,
  estimateFormMock,
  advisoryLockMock,
} = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    serviceCatalog: { findFirst: vi.fn() },
    lead: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  };
  return {
    prismaMock: {
      tx,
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    },
    publicWebsiteMock: {
      resolvePublicBookingIntegration: vi.fn(),
      resolvePublicEstimateIntegration: vi.fn(),
      resolvePublicContactIntegration: vi.fn(),
    },
    bookingFormMock: { submitPublicBookingFormById: vi.fn() },
    estimateFormMock: { submitPublicEstimateFormById: vi.fn() },
    advisoryLockMock: vi.fn(),
  };
});

vi.mock("../../lib/prisma/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireExtendedTextTransactionAdvisoryLock: advisoryLockMock,
}));
vi.mock("./publicWebsite.service", () => ({ PublicWebsiteService: publicWebsiteMock }));
vi.mock("../BookingForm/bookingForm.service", () => ({ bookingFormService: bookingFormMock }));
vi.mock("../EstimateForm/estimateForm.service", () => ({ estimateFormService: estimateFormMock }));

import { WebsiteAcquisitionService } from "./websiteAcquisition.service";

beforeEach(() => {
  vi.clearAllMocks();
  publicWebsiteMock.resolvePublicBookingIntegration.mockResolvedValue({
    websiteId: "website-1",
    adminId: "admin-1",
    formId: "booking-form-1",
  });
  publicWebsiteMock.resolvePublicEstimateIntegration.mockResolvedValue({
    websiteId: "website-1",
    adminId: "admin-1",
    formId: "estimate-form-1",
  });
  publicWebsiteMock.resolvePublicContactIntegration.mockResolvedValue({
    websiteId: "website-1",
    adminId: "admin-1",
    subdomain: "sparkle-cleaning",
    businessName: "Sparkle Cleaning",
  });
});

describe("Phase 14 website acquisition integration", () => {
  it("attributes website booking submissions to the resolved BusinessWebsite", async () => {
    bookingFormMock.submitPublicBookingFormById.mockResolvedValue({ ref: "#BK-1" });

    const payload = { serviceCatalogId: "service-1" } as any;
    const result = await WebsiteAcquisitionService.submitBooking("sparkle-cleaning", payload, "idem-booking-1");

    expect(bookingFormMock.submitPublicBookingFormById).toHaveBeenCalledWith(
      "booking-form-1",
      "admin-1",
      payload,
      "idem-booking-1",
      "website-1",
    );
    expect(result.submission.ref).toBe("#BK-1");
  });

  it("attributes website estimate submissions to the resolved BusinessWebsite", async () => {
    estimateFormMock.submitPublicEstimateFormById.mockResolvedValue({ ref: "#EST-1" });

    const payload = { serviceCatalogId: "service-1" } as any;
    const result = await WebsiteAcquisitionService.submitEstimate("sparkle-cleaning", payload, "idem-estimate-1");

    expect(estimateFormMock.submitPublicEstimateFormById).toHaveBeenCalledWith(
      "estimate-form-1",
      "admin-1",
      payload,
      "idem-estimate-1",
      "website-1",
    );
    expect(result.submission.ref).toBe("#EST-1");
  });

  it("creates a CRM lead with stable website and canonical service attribution", async () => {
    prismaMock.tx.serviceCatalog.findFirst.mockResolvedValue({ id: "service-1", serviceName: "Deep Clean" });
    prismaMock.tx.lead.findMany.mockResolvedValue([]);
    prismaMock.tx.$queryRaw.mockResolvedValue([{ maxNumber: "41" }]);
    prismaMock.tx.lead.create.mockResolvedValue({ leadRef: "LEAD-0042" });

    const result = await WebsiteAcquisitionService.submitContact("sparkle-cleaning", {
      name: "Jane Customer",
      email: "JANE@EXAMPLE.COM",
      phone: "+441234567890",
      message: "Please call me",
      serviceCatalogId: "service-1",
    });

    expect(prismaMock.tx.lead.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        adminId: "admin-1",
        serviceCatalogId: "service-1",
        serviceInterest: "Deep Clean",
        sourceWebsiteId: "website-1",
        sourceRef: "Website",
        email: "jane@example.com",
      }),
    }));
    expect(result.leadRef).toBe("LEAD-0042");
  });

  it("merges a website enquiry by normalized phone when the email is new", async () => {
    prismaMock.tx.serviceCatalog.findFirst.mockResolvedValue(null);
    prismaMock.tx.lead.findMany.mockResolvedValue([{
      id: "lead-1",
      email: "old@example.com",
      phone: "+441234567890",
      sourceRef: null,
      sourceWebsiteId: null,
      notes: null,
      createdAt: new Date("2026-01-01"),
    }]);
    prismaMock.tx.lead.update.mockResolvedValue({ leadRef: "LEAD-0007" });

    const result = await WebsiteAcquisitionService.submitContact("sparkle-cleaning", {
      name: "Jane Customer",
      email: "new@example.com",
      phone: "+44 (1234) 567-890",
      message: "Please arrange a weekly cleaning visit.",
    });

    expect(advisoryLockMock).toHaveBeenCalledWith(
      prismaMock.tx,
      "lead-phone:admin-1:+441234567890",
    );
    expect(prismaMock.tx.lead.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "lead-1" },
      data: expect.objectContaining({
        email: "old@example.com",
        phone: "+441234567890",
        sourceWebsiteId: "website-1",
      }),
    }));
    expect(result).toMatchObject({ leadRef: "LEAD-0007", merged: true });
  });

});
