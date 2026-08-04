/**
 * subscriptionExpiry.cron.test.ts
 *
 * Unit tests for runSubscriptionExpiryJob() in subscriptionExpiry.cron.ts.
 *
 * The job has two independent responsibilities that run every night:
 *   1. Expire ACTIVE, non-trial subscriptions whose currentPeriodEnd has
 *      passed -> status = EXPIRED.
 *   2. Expire ACTIVE trial subscriptions whose trialEndsAt has passed ->
 *      status = EXPIRED.
 * Both branches use the findMany -> updateMany({ id: { in: [...] } })
 * pattern (not a blind updateMany) specifically so a live notification can
 * be pushed per affected admin — see the BUGFIX comment in the source file.
 * These tests assert that behaviour directly rather than just "some update
 * happened", since a regression back to a blind updateMany would silently
 * drop the notifications while still looking green on a looser assertion.
 *
 * prisma, createNotification, and node-cron (via scheduleSubscriptionExpiryJob's
 * own test) are mocked so this runs with no real database, timers, or network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma/prisma", () => ({
    prisma: {
        subscription: {
            findMany: vi.fn(),
            updateMany: vi.fn(),
        },
    },
}));

vi.mock("../lib/utils/createNotification", () => ({
    createNotification: vi.fn().mockResolvedValue(undefined),
}));

// node-cron isn't exercised by runSubscriptionExpiryJob itself, but the module
// calls cron.schedule at import time via scheduleSubscriptionExpiryJob's own
// definition — mock it so importing this file never registers a real timer.
vi.mock("node-cron", () => ({
    default: { schedule: vi.fn() },
}));

import { prisma } from "../lib/prisma/prisma";
import { createNotification } from "../lib/utils/createNotification";
import { runSubscriptionExpiryJob } from "./subscriptionExpiry.cron";

const mockPrisma = prisma as unknown as {
    subscription: {
        findMany: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
    };
};
const mockCreateNotification = createNotification as ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
});

describe("runSubscriptionExpiryJob", () => {
    it("does nothing and sends no notifications when there is nothing to expire", async () => {
        mockPrisma.subscription.findMany.mockResolvedValue([]);

        await runSubscriptionExpiryJob();

        // Called twice: once for the paid-period query, once for the trial query.
        expect(mockPrisma.subscription.findMany).toHaveBeenCalledTimes(2);
        expect(mockPrisma.subscription.updateMany).not.toHaveBeenCalled();
        expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it("expires a lapsed paid subscription and notifies its admin", async () => {
        mockPrisma.subscription.findMany
            .mockResolvedValueOnce([{ id: "sub-1", adminId: "admin-1" }]) // paid query
            .mockResolvedValueOnce([]); // trial query

        await runSubscriptionExpiryJob();

        expect(mockPrisma.subscription.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["sub-1"] } },
            data: { status: "EXPIRED" },
        });
        expect(mockCreateNotification).toHaveBeenCalledTimes(1);
        expect(mockCreateNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                adminId: "admin-1",
                type: "SUBSCRIPTION",
                relatedId: "sub-1",
                title: expect.stringMatching(/expired/i),
            }),
        );
    });

    it("expires a lapsed trial and notifies its admin with trial-specific copy", async () => {
        mockPrisma.subscription.findMany
            .mockResolvedValueOnce([]) // paid query
            .mockResolvedValueOnce([{ id: "sub-2", adminId: "admin-2" }]); // trial query

        await runSubscriptionExpiryJob();

        expect(mockPrisma.subscription.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["sub-2"] } },
            data: { status: "EXPIRED" },
        });
        expect(mockCreateNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                adminId: "admin-2",
                relatedId: "sub-2",
                title: expect.stringMatching(/trial ended/i),
            }),
        );
    });

    it("handles both a paid expiry and a trial expiry in the same run independently", async () => {
        mockPrisma.subscription.findMany
            .mockResolvedValueOnce([
                { id: "sub-paid-1", adminId: "admin-1" },
                { id: "sub-paid-2", adminId: "admin-2" },
            ])
            .mockResolvedValueOnce([{ id: "sub-trial-1", adminId: "admin-3" }]);

        await runSubscriptionExpiryJob();

        // Two separate updateMany calls — one per branch — each scoped to its
        // own id set, never a single call mixing paid + trial subscription ids.
        expect(mockPrisma.subscription.updateMany).toHaveBeenCalledTimes(2);
        expect(mockPrisma.subscription.updateMany).toHaveBeenNthCalledWith(1, {
            where: { id: { in: ["sub-paid-1", "sub-paid-2"] } },
            data: { status: "EXPIRED" },
        });
        expect(mockPrisma.subscription.updateMany).toHaveBeenNthCalledWith(2, {
            where: { id: { in: ["sub-trial-1"] } },
            data: { status: "EXPIRED" },
        });
        expect(mockCreateNotification).toHaveBeenCalledTimes(3);
    });

    it("queries only ACTIVE, non-trial subscriptions with an elapsed currentPeriodEnd for the paid branch", async () => {
        mockPrisma.subscription.findMany.mockResolvedValue([]);

        await runSubscriptionExpiryJob();

        expect(mockPrisma.subscription.findMany).toHaveBeenNthCalledWith(1, {
            where: {
                status: "ACTIVE",
                isTrial: false,
                currentPeriodEnd: { lt: expect.any(Date) },
            },
            select: { id: true, adminId: true },
        });
    });

    it("queries only ACTIVE trial subscriptions with an elapsed trialEndsAt for the trial branch", async () => {
        mockPrisma.subscription.findMany.mockResolvedValue([]);

        await runSubscriptionExpiryJob();

        expect(mockPrisma.subscription.findMany).toHaveBeenNthCalledWith(2, {
            where: {
                status: "ACTIVE",
                isTrial: true,
                trialEndsAt: { lt: expect.any(Date) },
            },
            select: { id: true, adminId: true },
        });
    });

    it("still expires subscriptions even if pushing a notification for one of them fails", async () => {
        mockPrisma.subscription.findMany
            .mockResolvedValueOnce([{ id: "sub-1", adminId: "admin-1" }])
            .mockResolvedValueOnce([]);
        // createNotification failures are swallowed with .catch(() => {}) at the
        // call site specifically so a notification-delivery problem can never
        // block the actual expiry write — assert the job still resolves cleanly.
        mockCreateNotification.mockRejectedValueOnce(new Error("socket down"));

        await expect(runSubscriptionExpiryJob()).resolves.toBeUndefined();
        expect(mockPrisma.subscription.updateMany).toHaveBeenCalledTimes(1);
    });

    it("propagates a database error instead of silently swallowing it", async () => {
        const dbError = new Error("connection terminated unexpectedly");
        mockPrisma.subscription.findMany.mockRejectedValueOnce(dbError);

        await expect(runSubscriptionExpiryJob()).rejects.toThrow(dbError);
    });
});
