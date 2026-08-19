import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    bookingFormSubmission: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
    booking: { findMany: vi.fn() },
  };
  return {
    tx,
    bookingFormFindFirst: vi.fn(),
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    lock: vi.fn(),
  };
});

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    bookingForm: { findFirst: mocks.bookingFormFindFirst },
    $transaction: mocks.transaction,
  },
}));
vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireExtendedTextTransactionAdvisoryLock: mocks.lock,
}));
vi.mock("../../generated/prisma/enums", () => ({
  BookingStatus: { CANCELLED: "CANCELLED" },
  FormFieldType: {
    TEXT: "TEXT", EMAIL: "EMAIL", PHONE: "PHONE", ADDRESS: "ADDRESS",
    SELECT: "SELECT", NUMBER: "NUMBER", DATE: "DATE",
  },
  FormSubmissionStatus: { DECLINED: "DECLINED" },
  ServiceStatus: { ACTIVE: "ACTIVE", INACTIVE: "INACTIVE" },
}));
vi.mock("../../lib/utils/resolveAdminId", () => ({ getAdminId: vi.fn() }));
vi.mock("../Website/websiteProjectionCache.service", () => ({
  WebsiteProjectionCacheService: { invalidateAdminWebsite: vi.fn() },
}));
vi.mock("./bookingForm.cache", () => ({
  cacheBookingForm: vi.fn(),
  getCachedBookingForm: vi.fn(),
  invalidateBookingForm: vi.fn(),
  invalidateBookingFormsForAdmin: vi.fn(),
}));

import { bookingFormService } from "./bookingForm.service";

const nextMonday = () => {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  do date.setUTCDate(date.getUTCDate() + 1); while (date.getUTCDay() !== 1);
  return date.toISOString().slice(0, 10);
};

const activeForm = (overrides: Record<string, unknown> = {}) => ({
  id: "form-1",
  adminId: "admin-1",
  published: true,
  blockedDates: [],
  timeSlots: ["Monday|09:00-17:00"],
  availableDays: ["Monday"],
  maxBookingsPerSlot: 1,
  slotDurationMinutes: 120,
  bufferTimeMinutes: 0,
  services: [{
    serviceType: null,
    serviceCatalogId: "service-1",
    serviceCatalog: {
      id: "service-1",
      adminId: "admin-1",
      serviceName: "Deep Clean",
      basePrice: 120,
      duration: "120 min",
      addOns: [],
      status: "ACTIVE",
      onlineBookingEnabled: true,
      legacyServiceType: null,
    },
  }],
  fields: [],
  ...overrides,
});

const payload = () => ({
  serviceCatalogId: "service-1",
  date: nextMonday(),
  timeSlot: "09:00",
  name: "Jane Customer",
  email: "jane@example.com",
  phone: "+441234567890",
  address: "1 Test Street",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFormFindFirst.mockResolvedValue(activeForm());
  mocks.tx.bookingFormSubmission.findFirst.mockResolvedValue(null);
  mocks.tx.bookingFormSubmission.count.mockResolvedValue(0);
  mocks.tx.booking.findMany.mockResolvedValue([]);
  mocks.tx.bookingFormSubmission.create.mockResolvedValue({ id: "submission-1", ref: "#BK-1" });
});

describe("public website booking concurrency gates", () => {
  it("returns the existing idempotent submission before consuming slot capacity again", async () => {
    const existing = { id: "submission-existing", ref: "#BK-SAME", idempotencyKey: "website-click-123" };
    mocks.tx.bookingFormSubmission.findFirst.mockResolvedValue(existing);

    const result = await bookingFormService.submitPublicBookingFormById(
      "form-1",
      "admin-1",
      payload() as never,
      "website-click-123",
      "website-1",
    );

    expect(result).toBe(existing);
    expect(mocks.lock).toHaveBeenCalledWith(mocks.tx, "booking-idempotency:form-1:website-click-123");
    expect(mocks.tx.bookingFormSubmission.count).not.toHaveBeenCalled();
    expect(mocks.tx.bookingFormSubmission.create).not.toHaveBeenCalled();
  });

  it("fails closed when the selected slot reaches capacity before insert", async () => {
    mocks.tx.bookingFormSubmission.count.mockResolvedValue(1);

    await expect(bookingFormService.submitPublicBookingFormById(
      "form-1",
      "admin-1",
      payload() as never,
      "website-click-456",
      "website-1",
    )).rejects.toMatchObject({ statusCode: 409, code: "BOOKING_SLOT_FULL" });

    expect(mocks.tx.bookingFormSubmission.create).not.toHaveBeenCalled();
  });

  it("rejects a service that was disabled after the customer opened the page", async () => {
    mocks.bookingFormFindFirst.mockResolvedValue(activeForm({
      services: [{
        serviceType: null,
        serviceCatalogId: "service-1",
        serviceCatalog: {
          id: "service-1",
          adminId: "admin-1",
          serviceName: "Deep Clean",
          basePrice: 120,
          duration: "120 min",
          addOns: [],
          status: "INACTIVE",
          onlineBookingEnabled: false,
          legacyServiceType: null,
        },
      }],
    }));

    await expect(bookingFormService.submitPublicBookingFormById(
      "form-1",
      "admin-1",
      payload() as never,
      "website-click-789",
      "website-1",
    )).rejects.toMatchObject({ statusCode: 422, code: "BOOKING_SERVICE_UNAVAILABLE" });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
