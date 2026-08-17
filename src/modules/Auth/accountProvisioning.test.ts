import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const tx = { name: "tx" };
  return {
    order,
    tx,
    transaction: vi.fn(),
    createAdmin: vi.fn(),
    provisionWebsite: vi.fn(),
    createTrial: vi.fn(),
    invalidateSubdomains: vi.fn(),
  };
});

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

vi.mock("../Admin/admin.service", () => ({
  adminService: {
    createAdmin: mocks.createAdmin,
  },
}));

vi.mock("../Website/websiteProvisioning.service", () => ({
  WebsiteProvisioningService: {
    provisionDefaultWebsiteForAdminTx: mocks.provisionWebsite,
  },
}));

vi.mock("../Subscription/subscription.service", () => ({
  subscriptionService: {
    createTrialSubscription: mocks.createTrial,
  },
}));

vi.mock("../Website/websiteHostResolver.service", () => ({
  WebsiteHostResolverService: {
    invalidateSubdomains: mocks.invalidateSubdomains,
  },
}));

import { PROVISIONING_TRANSACTION_OPTIONS } from "../../lib/prisma/transactionPolicy";
import { AccountProvisioningService } from "./accountProvisioning.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;

  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(mocks.tx));
  mocks.createAdmin.mockImplementation(async () => {
    mocks.order.push("admin");
    return { id: "admin-1" };
  });
  mocks.provisionWebsite.mockImplementation(async () => {
    mocks.order.push("website");
    return { created: true, website: { id: "website-1", subdomain: "sparkle" } };
  });
  mocks.createTrial.mockImplementation(async () => {
    mocks.order.push("trial");
    return { id: "subscription-1" };
  });
});

describe("AccountProvisioningService", () => {
  it("provisions admin, website/default pages, then trial inside one bounded transaction", async () => {
    const result = await AccountProvisioningService.provisionRegisteredAdmin({
      userId: "user-1",
      businessName: "Sparkle Cleaning",
      trialDays: 14,
    });

    expect(mocks.order).toEqual(["admin", "website", "trial"]);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0]?.[1]).toEqual(PROVISIONING_TRANSACTION_OPTIONS);
    expect(mocks.createAdmin).toHaveBeenCalledWith(
      { userId: "user-1", businessName: "Sparkle Cleaning" },
      mocks.tx,
    );
    expect(mocks.provisionWebsite).toHaveBeenCalledWith(mocks.tx, {
      adminId: "admin-1",
      businessName: "Sparkle Cleaning",
      createdByUserId: "user-1",
    });
    expect(mocks.createTrial).toHaveBeenCalledWith("admin-1", {
      db: mocks.tx,
      trialDays: 14,
    });
    expect(result.website.id).toBe("website-1");
    expect(mocks.invalidateSubdomains).toHaveBeenCalledWith(["sparkle"]);
  });

  it("does not attempt trial creation when website provisioning fails", async () => {
    mocks.provisionWebsite.mockImplementation(async () => {
      mocks.order.push("website");
      throw new Error("website write failed");
    });

    await expect(
      AccountProvisioningService.provisionRegisteredAdmin({
        userId: "user-1",
        businessName: "Sparkle Cleaning",
        trialDays: 7,
      }),
    ).rejects.toThrow("website write failed");

    expect(mocks.order).toEqual(["admin", "website"]);
    expect(mocks.createTrial).not.toHaveBeenCalled();
  });

  it("rejects the whole provisioning transaction when trial creation fails", async () => {
    mocks.createTrial.mockImplementation(async () => {
      mocks.order.push("trial");
      throw new Error("trial plan missing");
    });

    await expect(
      AccountProvisioningService.provisionRegisteredAdmin({
        userId: "user-1",
        businessName: "Sparkle Cleaning",
        trialDays: 7,
      }),
    ).rejects.toThrow("trial plan missing");

    expect(mocks.order).toEqual(["admin", "website", "trial"]);
  });
});
