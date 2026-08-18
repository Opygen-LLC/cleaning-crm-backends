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

vi.mock("../Website/website.service", () => ({
  WebsiteService: {
    getWebsiteForAdmin: vi.fn(async () => ({
      id: "website-1",
      subdomain: "bio-cleaning",
      publicUrl: "https://bio-cleaning.sites.example.com",
      platformUrl: "https://bio-cleaning.sites.example.com",
    })),
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
const STEPS = ["business_profile", "branding", "services", "website_address", "template"];

const statusRow = (completed: string[] = [], finished: Date | null = null) => ({
  id: ADMIN_ID,
  updatedAt: new Date("2026-08-18T00:00:00Z"),
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
    expect(result.currentStep).toBe(2);
    expect(result.resumeStep).toBe("branding");
    expect(result.isComplete).toBe(false);
  });


  it("resumes step 3 after a browser refresh without losing saved progress", async () => {
    const row = statusRow(["business_profile", "branding"]);
    db.adminProfile.findUnique.mockResolvedValue(row);

    const beforeRefresh = await adminService.getOnboardingStatus(USER_ID);
    const afterRefresh = await adminService.getOnboardingStatus(USER_ID);

    expect(beforeRefresh).toMatchObject({ currentStep: 3, resumeStep: "services", completedCount: 2 });
    expect(afterRefresh).toMatchObject({ currentStep: 3, resumeStep: "services", completedCount: 2 });
  });

  it("restores persisted onboarding progress after logout/login", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow(["business_profile", "branding", "services"]));

    const firstSession = await adminService.getOnboardingStatus(USER_ID);
    const signedInAgain = await adminService.getOnboardingStatus(USER_ID);

    expect(firstSession.resumeStep).toBe("website_address");
    expect(signedInAgain.resumeStep).toBe("website_address");
    expect(signedInAgain.steps.slice(0, 3).every((step) => step.completed)).toBe(true);
  });

  it("keeps earlier steps completed when the owner navigates back from a later step", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow(["business_profile", "branding", "services", "website_address"]));

    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.currentStep).toBe(5);
    expect(result.steps.find((step) => step.key === "branding")?.completed).toBe(true);
    expect(result.steps.find((step) => step.key === "services")?.completed).toBe(true);
  });

  it("resumes at the first incomplete step without discarding progress saved in the old order", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow(["business_profile", "services"]));

    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.completedCount).toBe(2);
    expect(result.currentStep).toBe(2);
    expect(result.resumeStep).toBe("branding");
    expect(result.steps.find((step) => step.key === "services")?.completed).toBe(true);
  });

  it("treats an already completed legacy tenant as fully complete", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow([], new Date("2026-08-17T00:00:00Z")));
    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.isComplete).toBe(true);
    expect(result.completedCount).toBe(5);
    expect(result.steps.every((step) => step.completed)).toBe(true);
    expect(result.websiteSetupOffer).toBeNull();
  });

  it("offers an unpublished backfilled website to an already-onboarded customer", async () => {
    db.adminProfile.findUnique.mockResolvedValue({
      ...statusRow([], new Date("2026-08-17T00:00:00Z")),
      businessWebsite: {
        status: "PROVISIONED",
        subdomain: "bio-cleaning",
        publishedAt: null,
      },
    });

    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.isComplete).toBe(true);
    expect(result.websiteSetupOffer).toEqual({
      status: "PROVISIONED",
      subdomain: "bio-cleaning",
    });
  });

  it("does not show the setup offer after the website has been published", async () => {
    db.adminProfile.findUnique.mockResolvedValue({
      ...statusRow([], new Date("2026-08-17T00:00:00Z")),
      businessWebsite: {
        status: "PUBLISHED",
        subdomain: "bio-cleaning",
        publishedAt: new Date("2026-08-17T12:00:00Z"),
      },
    });

    const result = await adminService.getOnboardingStatus(USER_ID);

    expect(result.websiteSetupOffer).toBeNull();
  });

  it("rejects completing services before business information", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow([]));

    await expect(adminService.completeOnboardingStep(USER_ID, "services")).rejects.toMatchObject({
      statusCode: 409,
      code: "ONBOARDING_STEP_OUT_OF_ORDER",
    });
  });

  it("requires at least one ServiceCatalog record before completing services", async () => {
    db.adminProfile.findUnique.mockResolvedValue(statusRow(["business_profile", "branding"]));
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
    expect(result.onboarding.completedCount).toBe(5);
    expect(result.onboarding.isComplete).toBe(false);
    expect(result.publicUrl).toBe("https://bio-cleaning.sites.example.com");
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
    expect(result.onboarding.isComplete).toBe(true);
    expect(result.website.subdomain).toBe("bio-cleaning");
  });
});
