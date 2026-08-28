import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const tx = {
    user: { create: vi.fn() },
  };
  return {
    order,
    tx,
    transaction: vi.fn(),
    hashPassword: vi.fn(),
    createAdmin: vi.fn(),
    provisionWebsite: vi.fn(),
    createTrial: vi.fn(),
    enqueueVerification: vi.fn(),
    invalidateSubdomains: vi.fn(),
  };
});

vi.mock("better-auth/crypto", () => ({
  hashPassword: mocks.hashPassword,
}));

vi.mock("../../config/ENV", () => ({
  WEBSITE_BASE_DOMAIN: "sites.example.com",
}));

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

vi.mock("../../lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("../../lib/outbox/authEmailOutbox", () => ({
  AuthEmailOutbox: {
    enqueueEmailVerificationTx: mocks.enqueueVerification,
  },
}));

vi.mock("../Admin/admin.service", () => ({
  adminService: { createAdmin: mocks.createAdmin },
}));

vi.mock("../Website/websiteProvisioning.service", () => ({
  WebsiteProvisioningService: {
    provisionDefaultWebsiteForAdminTx: mocks.provisionWebsite,
  },
}));

vi.mock("../Subscription/subscription.service", () => ({
  subscriptionService: { createTrialSubscription: mocks.createTrial },
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

  mocks.hashPassword.mockResolvedValue("hashed-password");
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(mocks.tx));
  mocks.tx.user.create.mockImplementation(async ({ data }: any) => {
    mocks.order.push("user+account");
    return {
      id: data.id,
      name: data.name,
      email: data.email,
      emailVerified: false,
      image: null,
      role: "ADMIN",
      status: "PENDING",
      createdAt: new Date("2026-08-18T00:00:00.000Z"),
      updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    };
  });

  mocks.createAdmin.mockImplementation(async () => {
    mocks.order.push("admin");
    return { id: "admin-1", businessName: "Sparkle Cleaning" };
  });
  mocks.provisionWebsite.mockImplementation(async () => {
    mocks.order.push("website");
    return {
      created: true,
      website: { id: "website-1", subdomain: "sparkle", status: "PROVISIONED" },
    };
  });
  mocks.createTrial.mockImplementation(async () => {
    mocks.order.push("trial");
    return { id: "subscription-1" };
  });
  mocks.enqueueVerification.mockImplementation(async () => {
    mocks.order.push("outbox");
    return { id: "outbox-1" };
  });
  mocks.invalidateSubdomains.mockResolvedValue(undefined);
});

describe("AccountProvisioningService", () => {
  it("creates credential user + tenant website + trial + email outbox in one bounded transaction", async () => {
    const result = await AccountProvisioningService.provisionRegisteredAdmin({
      name: "Jamie Doe",
      email: "JAMIE@example.com",
      password: "Secret123!",
      businessName: "Sparkle Cleaning",
      trialDays: 14,
    });

    expect(mocks.order).toEqual(["user+account", "admin", "website", "trial", "outbox"]);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0]?.[1]).toEqual(PROVISIONING_TRANSACTION_OPTIONS);
    expect(mocks.hashPassword).toHaveBeenCalledWith("Secret123!");

    const userCreate = mocks.tx.user.create.mock.calls[0]?.[0];
    expect(userCreate.data.email).toBe("jamie@example.com");
    expect(userCreate.data.role).toBe("ADMIN");
    expect(userCreate.data.status).toBe("PENDING");

    const userId = userCreate.data.id;
    expect(userCreate.data.accounts).toEqual({
      create: expect.objectContaining({
        accountId: userId,
        providerId: "credential",
        password: "hashed-password",
      }),
    });
    expect(mocks.createAdmin).toHaveBeenCalledWith(
      { userId, businessName: "Sparkle Cleaning" },
      mocks.tx,
    );
    expect(mocks.provisionWebsite).toHaveBeenCalledWith(mocks.tx, {
      adminId: "admin-1",
      businessName: "Sparkle Cleaning",
      createdByUserId: userId,
    });
    expect(mocks.createTrial).toHaveBeenCalledWith("admin-1", {
      db: mocks.tx,
      trialDays: 14,
      skipExistingCheck: true,
    });
    expect(mocks.enqueueVerification).toHaveBeenCalledWith(
      mocks.tx,
      { userId, email: "jamie@example.com" },
      { dedupeKey: `registration-email-verification:${userId}` },
    );

    expect(result.website).toEqual({
      id: "website-1",
      subdomain: "sparkle",
      status: "PROVISIONED",
      publicUrl: "https://sparkle.sites.example.com",
    });
  });

  it("relies on the database unique-email constraint instead of SELECT-before-INSERT", async () => {
    const { Prisma } = await import("../../generated/prisma/client");
    mocks.tx.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7.7.0",
        meta: { target: ["email"], modelName: "User" },
      }),
    );

    await expect(AccountProvisioningService.provisionRegisteredAdmin({
      name: "Jamie Doe",
      email: "jamie@example.com",
      password: "Secret123!",
      businessName: "Sparkle Cleaning",
      trialDays: 7,
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(mocks.hashPassword).toHaveBeenCalledWith("Secret123!");
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("stops before outbox creation when trial creation fails", async () => {
    mocks.createTrial.mockImplementation(async () => {
      mocks.order.push("trial");
      throw new Error("trial plan missing");
    });

    await expect(AccountProvisioningService.provisionRegisteredAdmin({
      name: "Jamie Doe",
      email: "jamie@example.com",
      password: "Secret123!",
      businessName: "Sparkle Cleaning",
      trialDays: 7,
    })).rejects.toThrow("trial plan missing");

    expect(mocks.order).toEqual(["user+account", "admin", "website", "trial"]);
    expect(mocks.enqueueVerification).not.toHaveBeenCalled();
  });
});
