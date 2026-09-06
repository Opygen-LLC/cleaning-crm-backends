import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { onboardingStepSaveSchema } from "./onboardingSave.contract";
import { adminValidation } from "./admin.validation";

const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/onboarding-v2.json", import.meta.url), "utf8"));

describe("onboarding wire v2 with backend Zod 4", () => {
  it.each(["profileRequest", "brandingRequest", "servicesRequest"])("parses %s without a shared frontend runtime schema", key => {
    expect(onboardingStepSaveSchema.parse(fixture[key])).toEqual(fixture[key]);
  });
  it("accepts explicit null and preserves absent profile fields", () => {
    const result = onboardingStepSaveSchema.parse(fixture.profileRequest);
    expect(result.step).toBe("business_profile");
    if (result.step !== "business_profile") throw new Error("unexpected discriminator");
    expect(result.profile.businessEmail).toBeNull();
    expect(result.profile.postcode).toBeNull();
    expect(result.profile).not.toHaveProperty("currency");
    expect(result.profile).not.toHaveProperty("mobileNumber");
  });
  it("normalizes international phones before persistence", () => {
    const result = onboardingStepSaveSchema.parse({ ...fixture.profileRequest, profile: { mobileNumber: "0044 7700 900123" } });
    expect(result).toMatchObject({ profile: { mobileNumber: "+447700900123" } });
  });
  it("rejects ambiguous postcode/zipcode and unsupported versions", () => {
    expect(onboardingStepSaveSchema.safeParse({ ...fixture.profileRequest, profile: { postcode: null, zipcode: "SW1A" } }).success).toBe(false);
    expect(onboardingStepSaveSchema.safeParse({ ...fixture.brandingRequest, schemaVersion: 1 }).success).toBe(false);
    expect(onboardingStepSaveSchema.safeParse({ ...fixture.servicesRequest, catalogVersion: "not-a-version" }).success).toBe(false);
    expect(onboardingStepSaveSchema.safeParse({ ...fixture.profileRequest, profile: { mobileNumber: "07700900123" } }).success).toBe(false);
  });
  it("accepts a no-op explicit change set and more than a legacy 100-row page", () => {
    const row = { serviceName: "Cleaning", description: "Details", basePrice: 10, duration: "2h", category: "RESIDENTIAL", onlineBookingEnabled: true, addOns: [] };
    expect(onboardingStepSaveSchema.safeParse(fixture.servicesRequest).success).toBe(true);
    expect(onboardingStepSaveSchema.safeParse({ ...fixture.servicesRequest, services: Array.from({length: 205}, (_, i) => ({ ...row, serviceName: `Cleaning ${i}` })) }).success).toBe(true);
    expect(onboardingStepSaveSchema.safeParse({ ...fixture.servicesRequest, services: [{ ...row, addOns: [{ name: "Extra", price: -1 }] }] }).success).toBe(false);
  });
  it("retains the legacy template milestone only at the API boundary", () => {
    expect(adminValidation.completeOnboardingStep.parse({ step: "template" })).toEqual({ step: "template" });
    expect(onboardingStepSaveSchema.safeParse({ ...fixture.brandingRequest, step: "template" }).success).toBe(false);
  });
});
