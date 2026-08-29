import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    adminProfile: { findUnique: vi.fn(), update: vi.fn() },
    serviceCatalog: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
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
  serviceCatalog: { findFirst: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
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


const bootstrapRow = (overrides: Record<string, unknown> = {}) => ({
  id: ADMIN_ID,
  businessName: "Bio Cleaning",
  businessEmail: "hello@example.com",
  mobileNumber: "+44000000000",
  businessDescription: "Reliable cleaners",
  businessHours: null,
  address: "1 Main Street",
  city: "London",
  zipcode: "SW1A 1AA",
  currency: "GBP",
  updatedAt: new Date("2026-08-18T00:00:00Z"),
  onboardingCompletedAt: null,
  onboardingCompletedSteps: ["business_profile"],
  user: { id: USER_ID, role: "ADMIN", status: "ACTIVE" },
  businessWebsite: {
    id: "website-1",
    subdomain: "bio-cleaning",
    status: "PROVISIONED",
    logo: null,
    primaryColor: "#0F766E",
    secondaryColor: "#0F172A",
    accentColor: "#14B8A6",
    font: "Sora",
    bookingEnabled: false,
    templateId: "clean-modern",
    updatedAt: new Date("2026-08-18T00:01:00Z"),
  },
  subscription: [{ id: "trial-subscription-1" }],
  ...overrides,
});

const optionalCounts = () => {
  db.$queryRaw.mockResolvedValue([{
    hasServiceArea: false,
    hasTeam: false,
    hasClient: false,
    hasBooking: false,
    hasPublishedBookingForm: false,
  }]);
};

beforeEach(() => {
  vi.clearAllMocks();
  optionalCounts();
  db.serviceCatalog.findFirst.mockResolvedValue({ id: "service-1" });
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
    db.serviceCatalog.findFirst.mockResolvedValue(null);

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


describe("onboarding bootstrap contract", () => {
  it("returns one compact validated snapshot for a verified fresh account", async () => {
    db.adminProfile.findUnique.mockResolvedValue(bootstrapRow());

    const result = await adminService.getOnboardingBootstrap(USER_ID);

    expect(result.user).toEqual({ id: USER_ID, role: "ADMIN", status: "ACTIVE" });
    expect(result.onboarding).toMatchObject({
      currentStep: 2,
      completedSteps: ["business_profile"],
      isComplete: false,
    });
    expect(result.profile).toMatchObject({
      businessName: "Bio Cleaning",
      postcode: "SW1A 1AA",
      currency: "GBP",
    });
    expect(result.website).toMatchObject({
      id: "website-1",
      subdomain: "bio-cleaning",
      templateId: "clean-modern",
      bookingEnabled: false,
    });

    const select = db.adminProfile.findUnique.mock.calls[0]?.[0]?.select;
    const serializedSelect = JSON.stringify(select);
    for (const forbidden of ["pages", "assets", "revisions", "domains", "analyticsEvents", "bookingForms", "estimateForms"]) {
      expect(serializedSelect).not.toContain(`\"${forbidden}\"`);
    }
  });

  it("normalizes malformed legacy business hours instead of breaking onboarding", async () => {
    db.adminProfile.findUnique.mockResolvedValue(bootstrapRow({
      businessHours: { monday: { isOpen: true, opensAt: "9am", closesAt: "5pm" } },
    }));

    const result = await adminService.getOnboardingBootstrap(USER_ID);

    expect(result.profile.businessHours).toMatchObject({
      monday: { isOpen: true, opensAt: "09:00", closesAt: "17:00" },
      saturday: { isOpen: false, opensAt: "09:00", closesAt: "17:00" },
      sunday: { isOpen: false, opensAt: "09:00", closesAt: "17:00" },
    });
  });

  it("resumes the same bootstrap step after refresh/login", async () => {
    db.adminProfile.findUnique.mockResolvedValue(bootstrapRow({
      onboardingCompletedSteps: ["business_profile", "branding", "services"],
    }));

    const first = await adminService.getOnboardingBootstrap(USER_ID);
    const second = await adminService.getOnboardingBootstrap(USER_ID);

    expect(first.onboarding.currentStep).toBe(4);
    expect(second.onboarding.currentStep).toBe(4);
    expect(second.onboarding.completedSteps).toEqual([
      "business_profile",
      "branding",
      "services",
    ]);
  });

  it("fails deterministically while account activation is incomplete", async () => {
    db.adminProfile.findUnique.mockResolvedValue(bootstrapRow({
      user: { id: USER_ID, role: "ADMIN", status: "PENDING" },
    }));

    await expect(adminService.getOnboardingBootstrap(USER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCOUNT_ACTIVATION_INCOMPLETE",
    });
  });

  it("fails deterministically if trial/subscription provisioning is missing", async () => {
    db.adminProfile.findUnique.mockResolvedValue(bootstrapRow({ subscription: [] }));

    await expect(adminService.getOnboardingBootstrap(USER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "SUBSCRIPTION_PROVISIONING_INCOMPLETE",
    });
  });

  it("fails deterministically if website provisioning is missing", async () => {
    db.adminProfile.findUnique.mockResolvedValue(bootstrapRow({ businessWebsite: null }));

    await expect(adminService.getOnboardingBootstrap(USER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: "WEBSITE_PROVISIONING_INCOMPLETE",
    });
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
