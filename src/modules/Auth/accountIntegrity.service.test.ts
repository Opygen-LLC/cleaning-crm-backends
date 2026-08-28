import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findAdmin: vi.fn(),
  transaction: vi.fn(),
  getPlatformConfig: vi.fn(),
  createTrial: vi.fn(),
  provisionWebsite: vi.fn(),
  invalidate: vi.fn(),
  lock: vi.fn(),
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.findUser },
    adminProfile: { findUnique: mocks.findAdmin },
    $transaction: mocks.transaction,
  },
}));
vi.mock("../../lib/utils/platformConfig", () => ({ getPlatformConfig: mocks.getPlatformConfig }));
vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireExtendedTextTransactionAdvisoryLock: mocks.lock,
}));
vi.mock("../Subscription/subscription.service", () => ({
  subscriptionService: { createTrialSubscription: mocks.createTrial },
}));
vi.mock("../Website/websiteProvisioning.service", () => ({
  WebsiteProvisioningService: { provisionDefaultWebsiteForAdminTx: mocks.provisionWebsite },
}));
vi.mock("../Website/websiteHostResolver.service", () => ({
  WebsiteHostResolverService: { invalidateSubdomains: mocks.invalidate },
}));
vi.mock("../../lib/logger", () => ({ default: { warn: vi.fn() } }));

import { AccountStatus, UserRole } from "../../generated/prisma/enums";
import { AccountIntegrityService } from "./accountIntegrity.service";

describe("AccountIntegrityService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlatformConfig.mockResolvedValue({ defaultTrialDays: 14 });
    mocks.invalidate.mockResolvedValue(undefined);
  });

  it("treats expired/cancelled subscription history as structurally valid", async () => {
    mocks.findUser.mockResolvedValue({
      id: "u1",
      role: UserRole.ADMIN,
      status: AccountStatus.ACTIVE,
      emailVerified: true,
      admin: { id: "a1", businessWebsite: { id: "w1" }, subscription: [{ id: "s-old" }] },
    });

    await expect(AccountIntegrityService.inspectActiveAdminProvisioning("u1")).resolves.toMatchObject({
      healthy: true,
      issues: [],
    });
  });

  it("requires an active subscription before verification activation", async () => {
    mocks.findAdmin.mockResolvedValue({
      id: "a1",
      onboardingCompletedAt: null,
      businessWebsite: { id: "w1" },
      subscription: [],
    });

    await expect(AccountIntegrityService.assertAdminReadyForActivation("u1")).rejects.toMatchObject({
      code: "SUBSCRIPTION_PROVISIONING_INCOMPLETE",
    });
  });

  it("repairs missing profile, subscription and website in one idempotent transaction", async () => {
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: "u1",
          name: "Acme Cleaning",
          email: "owner@example.com",
          role: UserRole.ADMIN,
          status: AccountStatus.ACTIVE,
          emailVerified: true,
          admin: null,
        }),
      },
      adminProfile: {
        create: vi.fn().mockResolvedValue({
          id: "a1",
          businessName: "Acme Cleaning",
          businessWebsite: null,
          subscription: [],
        }),
      },
    };
    mocks.transaction.mockImplementation(async (fn: (arg: typeof tx) => unknown) => fn(tx));
    mocks.createTrial.mockResolvedValue({ id: "s1" });
    mocks.provisionWebsite.mockResolvedValue({
      created: true,
      website: { id: "w1", subdomain: "acme-cleaning" },
    });

    const result = await AccountIntegrityService.repairActiveAdminProvisioning("u1");

    expect(result.actions).toEqual([
      "ADMIN_PROFILE_CREATED",
      "TRIAL_SUBSCRIPTION_CREATED",
      "BUSINESS_WEBSITE_CREATED",
    ]);
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(mocks.createTrial).toHaveBeenCalledWith("a1", expect.objectContaining({ db: tx, trialDays: 14 }));
    expect(mocks.invalidate).toHaveBeenCalledWith(["acme-cleaning"]);
  });
});
