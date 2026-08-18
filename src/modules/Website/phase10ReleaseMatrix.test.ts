import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 10 release-gate manifest. These case ids map the mandatory production
 * journeys to behavioral suites in this repository. The manifest itself is a
 * guard against silently dropping a release journey when tests are reorganized.
 */
const matrix = {
  registration: {
    uniqueCompany: "src/modules/Website/websiteProvisioning.test.ts",
    duplicateCompanyNames: "src/modules/Website/subdomain.service.test.ts",
    sameProposedSlug: "src/modules/Website/subdomain.service.test.ts",
    concurrentRegistrations: "src/modules/Website/websiteProvisioning.test.ts",
    rollbackIfTrialFails: "src/modules/Auth/accountProvisioning.test.ts",
  },
  onboarding: {
    normalCompletion: "src/modules/Admin/admin.service.onboarding.test.ts",
    refreshDuringStep3: "src/modules/Admin/admin.service.onboarding.test.ts",
    logoutLoginResume: "src/modules/Admin/admin.service.onboarding.test.ts",
    skip: "src/modules/Admin/admin.service.onboarding.test.ts",
    backNavigation: "src/modules/Admin/admin.service.onboarding.test.ts",
    subdomainCollision: "src/modules/Website/subdomain.service.test.ts",
    premiumTemplateRestriction: "src/modules/Website/websiteEntitlement.service.test.ts",
  },
  website: {
    draftDoesNotAffectPublicSite: "src/modules/Website/websiteSnapshot.test.ts",
    publishUpdatesPublicSite: "src/modules/Website/websitePublishCacheInvalidation.test.ts",
    revisionRestore: "src/modules/Website/websiteStudio.service.test.ts",
    logoUpload: "src/modules/Website/websiteAsset.service.test.ts",
    themeSwitching: "src/modules/Website/templateSelection.test.ts",
  },
  booking: {
    bookingEnabled: "src/modules/Website/websiteBookingProvisioning.service.test.ts",
    bookingDisabled: "src/modules/Website/websiteBookingProvisioning.service.test.ts",
    oneBookingForm: "src/modules/Website/websiteBookingProvisioning.service.test.ts",
    multipleForms: "src/modules/Website/websiteBookingProvisioning.service.test.ts",
    noBookingForm: "src/modules/Website/websiteBookingProvisioning.service.test.ts",
    serviceDisabled: "src/modules/BookingForm/bookingForm.publicSubmission.test.ts",
    slotCollision: "src/modules/BookingForm/bookingForm.publicSubmission.test.ts",
    doubleClickSubmission: "src/modules/BookingForm/bookingForm.publicSubmission.test.ts",
  },
  domains: {
    wildcard: "src/modules/Website/websiteHostResolver.production.test.ts",
    oldAlias: "src/modules/Website/websiteHostResolver.production.test.ts",
    customDomain: "src/modules/Website/websiteDomainLifecycle.test.ts",
    unverifiedDomain: "src/modules/Website/websiteHostResolver.production.test.ts",
    primaryDomain: "src/modules/Website/websiteCanonicalHost.test.ts",
    suspendedTenant: "src/modules/Website/websiteHostResolver.production.test.ts",
  },
  performance: {
    dashboard500: "src/scripts/load/phase10LoadTest.ts --mode=dashboard --users=500",
    public500: "src/scripts/load/phase10LoadTest.ts --mode=public --users=500",
  },
} as const;

describe("Phase 10 mandatory release matrix", () => {
  it("keeps every required journey assigned to an automated suite/load scenario", () => {
    const sections = Object.values(matrix);
    expect(sections).toHaveLength(6);
    for (const section of sections) {
      for (const target of Object.values(section)) {
        expect(target.length).toBeGreaterThan(10);
        const file = target.split(" --", 1)[0]!;
        expect(existsSync(resolve(process.cwd(), file)), `Missing release-gate target: ${file}`).toBe(true);
      }
    }
  });
});
