import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    adminProfile: { findUnique: vi.fn(), update: vi.fn() },
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

const db = prisma as unknown as {
  adminProfile: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  serviceCatalog: { count: ReturnType<typeof vi.fn> };
  workLocation: { count: ReturnType<typeof vi.fn> };
  staffProfile: { count: ReturnType<typeof vi.fn> };
  client: { count: ReturnType<typeof vi.fn> };
  booking: { count: ReturnType<typeof vi.fn> };
  bookingForm: { count: ReturnType<typeof vi.fn> };
};

const USER_ID = "user-1";
const ADMIN_ID = "admin-1";
const STEPS = ["business_profile", "services", "branding", "website_address", "template"];

const statusRow = (completed: string[] = [], finished: Date | null = null) => ({
  id: ADMIN_ID,
  onboardingCompletedAt: finished,
  onboardingCompletedSteps: completed,
});

const optionalCounts = () => {
  db.workLocation.count.mockResolvedValue(0);
  db.staffProfile.count.mockResolvedValue(0);
  db.client.count.mockResolvedValue(0);
  db.booking.count.mockResolvedValue(0);
  db.bookingForm.count.mockResolvedValue(0);
};

beforeEach(() => {
  vi.clearAllMocks();
  optionalCounts();
  db.serviceCatalog.count.mockResolvedValue(1);
});

describe("website-first onboarding status", () => {
  it("returns the five explicit setup steps", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow(["business_profile"]));
    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.steps.map((step) => step.key)).toEqual(STEPS);
    expect(result.totalCount).toBe(5);
    expect(result.completedCount).toBe(1);
    expect(result.isComplete).toBe(false);
  });

  it("treats an already completed legacy tenant as fully complete", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow([], new Date("2026-08-17T00:00:00Z")));
    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.isComplete).toBe(true);
    expect(result.completedCount).toBe(5);
    expect(result.steps.every((step) => step.completed)).toBe(true);
  });

  it("rejects completing services before business information", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow([]));

    await expect(adminService.completeOnboardingStep(USER_ID, "services")).rejects.toMatchObject({
      statusCode: 409,
      code: "ONBOARDING_STEP_OUT_OF_ORDER",
    });
  });

  it("requires at least one ServiceCatalog record before completing services", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow(["business_profile"]));
    db.serviceCatalog.count.mockResolvedValue(0);

    await expect(adminService.completeOnboardingStep(USER_ID, "services")).rejects.toMatchObject({
      statusCode: 409,
      code: "ONBOARDING_SERVICE_REQUIRED",
    });
  });

  it("marks every setup step for skip without stamping completion before publish", async () => {
    db.adminProfile.findUnique
      .mockResolvedValueOnce({ id: ADMIN_ID, onboardingCompletedAt: null })
      .mockResolvedValueOnce(statusRow(STEPS));
    db.adminProfile.update.mockResolvedValue({});

    const result = await adminService.skipWebsiteOnboardingSetup(USER_ID);

    expect(db.adminProfile.update).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      data: { onboardingCompletedSteps: STEPS },
    });
    expect(result.completedCount).toBe(5);
    expect(result.isComplete).toBe(false);
  });
});

describe("onboarding finalization", () => {
  it("requires a published website before stamping completion", async () => {
    db.adminProfile.findUnique.mockResolvedValue({
      ...statusRow(STEPS),
      businessWebsite: { status: "DRAFT", publishedAt: null },
    });

    await expect(adminService.finalizeOnboardingSetup(USER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "WEBSITE_NOT_PUBLISHED",
    });
  });

  it("stamps completion after all steps and a successful website publish", async () => {
    db.adminProfile.findUnique
      .mockResolvedValueOnce({
        ...statusRow(STEPS),
        businessWebsite: { status: "PUBLISHED", publishedAt: new Date("2026-08-17T10:00:00Z") },
      })
      .mockResolvedValueOnce(statusRow(STEPS, new Date("2026-08-17T10:01:00Z")));
    db.adminProfile.update.mockResolvedValue({});

    const result = await adminService.finalizeOnboardingSetup(USER_ID);

    expect(db.adminProfile.update).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      data: { onboardingCompletedAt: expect.any(Date) },
    });
    expect(result.isComplete).toBe(true);
  });
});
