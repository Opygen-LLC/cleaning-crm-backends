/**
 * Regression coverage for the Phase 2 three-step account setup and the
 * dashboard Getting Started checklist. Prisma is mocked; no database needed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    adminProfile: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    serviceCatalog: { count: vi.fn() },
    workLocation: { count: vi.fn() },
    staffProfile: { count: vi.fn() },
    client: { count: vi.fn() },
    booking: { count: vi.fn() },
    bookingForm: { count: vi.fn() },
  },
}));

import { prisma } from "../../lib/prisma/prisma";
import { adminService } from "./admin.service";

const mockPrisma = prisma as unknown as {
  adminProfile: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  serviceCatalog: { count: ReturnType<typeof vi.fn> };
  workLocation: { count: ReturnType<typeof vi.fn> };
  staffProfile: { count: ReturnType<typeof vi.fn> };
  client: { count: ReturnType<typeof vi.fn> };
  booking: { count: ReturnType<typeof vi.fn> };
  bookingForm: { count: ReturnType<typeof vi.fn> };
};

const USER_ID = "user-1";
const ADMIN_ID = "admin-1";

function makeAdminRow(overrides: Partial<{
  onboardingCompletedAt: Date | null;
  businessProfileComplete: boolean;
  skippedSteps: string[];
}> = {}) {
  const complete = overrides.businessProfileComplete ?? true;
  return {
    id: ADMIN_ID,
    onboardingCompletedAt: overrides.onboardingCompletedAt ?? null,
    businessName: "Sparkle Co",
    city: complete ? "Manchester" : null,
    country: complete ? "UNITED_KINGDOM" : null,
    mobileNumber: complete ? "+447700900123" : null,
    businessType: complete ? "Residential" : null,
    skippedSteps: overrides.skippedSteps ?? [],
  };
}

function setCounts(counts: Partial<{
  service: number;
  serviceArea: number;
  team: number;
  client: number;
  booking: number;
  onlineBooking: number;
}> = {}) {
  mockPrisma.serviceCatalog.count.mockResolvedValue(counts.service ?? 0);
  mockPrisma.workLocation.count.mockResolvedValue(counts.serviceArea ?? 0);
  mockPrisma.staffProfile.count.mockResolvedValue(counts.team ?? 0);
  mockPrisma.client.count.mockResolvedValue(counts.client ?? 0);
  mockPrisma.booking.count.mockResolvedValue(counts.booking ?? 0);
  mockPrisma.bookingForm.count.mockResolvedValue(counts.onlineBooking ?? 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  setCounts();
});

describe("three-step account setup", () => {
  it("returns exactly three required setup steps and seven Getting Started items", async () => {
    mockPrisma.adminProfile.findUnique.mockResolvedValue(
      makeAdminRow({ businessProfileComplete: false }),
    );

    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.steps.map((step) => step.key)).toEqual([
      "business_profile",
      "service",
      "service_area",
    ]);
    expect(result.totalCount).toBe(3);
    expect(result.isComplete).toBe(false);
    expect(result.gettingStarted.totalCount).toBe(7);
    expect(result.gettingStarted.steps.map((step) => step.key)).toEqual([
      "business_profile",
      "service",
      "service_area",
      "team",
      "client",
      "booking",
      "online_booking",
    ]);
  });

  it("finishes setup after business + service + service area even when optional CRM tasks are untouched", async () => {
    mockPrisma.adminProfile.findUnique.mockResolvedValue(makeAdminRow());
    setCounts({ service: 1, serviceArea: 1 });

    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.isComplete).toBe(true);
    expect(result.completedCount).toBe(3);
    expect(result.gettingStarted.completedCount).toBe(3);
    expect(result.gettingStarted.isComplete).toBe(false);
    expect(mockPrisma.adminProfile.update).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      data: { onboardingCompletedAt: expect.any(Date) },
    });
  });

  it("once setup is stamped, skips service/location recounts and checks only optional live progress", async () => {
    mockPrisma.adminProfile.findUnique.mockResolvedValue(
      makeAdminRow({ onboardingCompletedAt: new Date("2026-08-13T00:00:00Z") }),
    );
    setCounts({ team: 1, client: 1, booking: 1, onlineBooking: 1 });

    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.isComplete).toBe(true);
    expect(result.gettingStarted.isComplete).toBe(true);
    expect(mockPrisma.serviceCatalog.count).not.toHaveBeenCalled();
    expect(mockPrisma.workLocation.count).not.toHaveBeenCalled();
    expect(mockPrisma.staffProfile.count).toHaveBeenCalledTimes(1);
    expect(mockPrisma.bookingForm.count).toHaveBeenCalledWith({
      where: { adminId: ADMIN_ID, published: true },
    });
  });

  it("finalize rejects an incomplete setup with a stable error code and field errors", async () => {
    mockPrisma.adminProfile.findUnique.mockResolvedValue(makeAdminRow());
    setCounts({ service: 1, serviceArea: 0 });

    await expect(adminService.finalizeOnboardingSetup(USER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCOUNT_SETUP_INCOMPLETE",
      fieldErrors: {
        service_area: expect.any(String),
      },
    });
  });

  it("finalize succeeds when the three required records exist", async () => {
    mockPrisma.adminProfile.findUnique.mockResolvedValue(makeAdminRow());
    setCounts({ service: 1, serviceArea: 1 });

    const result = await adminService.finalizeOnboardingSetup(USER_ID);

    expect(result.isComplete).toBe(true);
    expect(result.steps.every((step) => step.completed)).toBe(true);
  });
});

describe("legacy skip compatibility", () => {
  it("keeps old optional skip calls idempotent without affecting the new setup contract", async () => {
    mockPrisma.adminProfile.findUnique.mockResolvedValue(
      makeAdminRow({ skippedSteps: ["team"] }),
    );

    const result = await adminService.skipOnboardingStep(USER_ID, "team");

    expect(result).toEqual({ step: "team", skipped: true, deprecated: true });
    expect(mockPrisma.adminProfile.update).not.toHaveBeenCalled();
  });
});
