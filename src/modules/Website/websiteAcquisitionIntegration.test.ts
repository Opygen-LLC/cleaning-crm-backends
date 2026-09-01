import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  publicWebsiteMock,
  bookingFormMock,
  bookingServiceMock,
  estimateFormMock,
  advisoryLockMock,
} = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    serviceCatalog: { findFirst: vi.fn() },
    lead: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    bookingFormSubmission: { deleteMany: vi.fn() },
    websiteSubmission: { create: vi.fn(), deleteMany: vi.fn() },
  };
  return {
    prismaMock: {
      tx,
      bookingFormSubmission: { deleteMany: vi.fn() },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    },
    publicWebsiteMock: {
      resolvePublicBookingIntegration: vi.fn(),
      resolvePublicEstimateIntegration: vi.fn(),
      resolvePublicContactIntegration: vi.fn(),
    },
    bookingFormMock: { submitPublicBookingFormById: vi.fn() },
    bookingServiceMock: { convertWebsiteBookingFormSubmission: vi.fn() },
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
vi.mock("../Booking/booking.service", () => ({ bookingService: bookingServiceMock }));
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
  prismaMock.tx.websiteSubmission.create.mockResolvedValue({ id: "ws-1", ref: "WS-TEST" });
  publicWebsiteMock.resolvePublicContactIntegration.mockResolvedValue({
    websiteId: "website-1",
    adminId: "admin-1",
    subdomain: "sparkle-cleaning",
    businessName: "Sparkle Cleaning",
  });
});

describe("Phase 14 website acquisition integration", () => {
  it("attributes website booking submissions to the resolved BusinessWebsite", async () => {
    bookingFormMock.submitPublicBookingFormById.mockResolvedValue({ id: "submission-1", ref: "#BK-1" });
    bookingServiceMock.convertWebsiteBookingFormSubmission.mockResolvedValue({
      booking: { id: "booking-1", bookingRef: "BK-0042" },
      alreadyConverted: false,
    });

    const payload = { serviceCatalogId: "service-1" } as any;
    const result = await WebsiteAcquisitionService.submitBooking("sparkle-cleaning", payload, "idem-booking-1");

    expect(bookingFormMock.submitPublicBookingFormById).toHaveBeenCalledWith(
      "booking-form-1",
      "admin-1",
      payload,
      "idem-booking-1",
      "website-1",
    );
    expect(bookingServiceMock.convertWebsiteBookingFormSubmission).toHaveBeenCalledWith("submission-1", "admin-1");
    expect(result.submission.ref).toBe("#BK-1");
    expect(result.booking.bookingRef).toBe("BK-0042");
  });

  it("removes an unconverted website submission when canonical booking creation fails", async () => {
    bookingFormMock.submitPublicBookingFormById.mockResolvedValue({ id: "submission-2", ref: "#BK-2" });
    bookingServiceMock.convertWebsiteBookingFormSubmission.mockRejectedValue(new Error("Booking capacity changed"));
    prismaMock.bookingFormSubmission.deleteMany.mockResolvedValue({ count: 1 });

    const payload = { serviceCatalogId: "service-1" } as any;

    await expect(
      WebsiteAcquisitionService.submitBooking("sparkle-cleaning", payload, "idem-booking-2"),
    ).rejects.toThrow("Booking capacity changed");

    expect(prismaMock.tx.websiteSubmission.deleteMany).toHaveBeenCalledWith({
      where: { bookingFormSubmissionId: "submission-2" },
    });
    expect(prismaMock.tx.bookingFormSubmission.deleteMany).toHaveBeenCalledWith({
      where: { id: "submission-2", convertedBookingId: null },
    });
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
    prismaMock.tx.lead.create.mockResolvedValue({ id: "lead-42", leadRef: "LEAD-0042" });

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
    expect(prismaMock.tx.websiteSubmission.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: "CONTACT",
        adminId: "admin-1",
        websiteId: "website-1",
        leadId: "lead-42",
        serviceCatalogId: "service-1",
        email: "jane@example.com",
        summary: "Please call me",
      }),
    }));
    expect(result).toMatchObject({ leadRef: "LEAD-0042", submissionRef: "WS-TEST" });
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
    prismaMock.tx.lead.update.mockResolvedValue({ id: "lead-1", leadRef: "LEAD-0007" });

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
    expect(prismaMock.tx.websiteSubmission.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ leadId: "lead-1", kind: "CONTACT", summary: "Please arrange a weekly cleaning visit." }),
    }));
    expect(result).toMatchObject({ leadRef: "LEAD-0007", submissionRef: "WS-TEST", merged: true });
  });

  it("preserves repeated contact events even when they merge into the same lead", async () => {
    prismaMock.tx.serviceCatalog.findFirst.mockResolvedValue(null);
    prismaMock.tx.lead.findMany.mockResolvedValue([{
      id: "lead-1", email: "jane@example.com", phone: "+441234567890", sourceRef: "Website",
      sourceWebsiteId: "website-1", notes: null, createdAt: new Date("2026-01-01"),
    }]);
    prismaMock.tx.lead.update.mockResolvedValue({ id: "lead-1", leadRef: "LEAD-0007" });
    prismaMock.tx.websiteSubmission.create
      .mockResolvedValueOnce({ id: "ws-1", ref: "WS-FIRST" })
      .mockResolvedValueOnce({ id: "ws-2", ref: "WS-SECOND" });

    const first = await WebsiteAcquisitionService.submitContact("sparkle-cleaning", {
      name: "Jane Customer", email: "jane@example.com", phone: "+441234567890", message: "First website enquiry message.",
    });
    const second = await WebsiteAcquisitionService.submitContact("sparkle-cleaning", {
      name: "Jane Customer", email: "jane@example.com", phone: "+441234567890", message: "Second website enquiry message.",
    });

    expect(prismaMock.tx.lead.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.tx.websiteSubmission.create).toHaveBeenCalledTimes(2);
    expect(first.submissionRef).toBe("WS-FIRST");
    expect(second.submissionRef).toBe("WS-SECOND");
  });

});
