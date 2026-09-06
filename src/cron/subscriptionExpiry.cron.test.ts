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
 * Both branches use findMany -> conditional per-record updateMany in a transaction;
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

const state = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn(), enqueue: vi.fn(), deliver: vi.fn() }));
vi.mock("../lib/prisma/prisma", () => {
    const tx = { subscription: { findMany: state.findMany, updateMany: state.updateMany } };
    return { prisma: { ...tx, $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("../modules/SuperAdmin/tenantAdmin.service", () => ({ applyDueAdministrativePlanChanges: vi.fn(async () => undefined) }));
vi.mock("../lib/outbox/publicWebsiteCacheOutbox", () => ({ PublicWebsiteCacheOutbox: { enqueueTenantDeliveryTx: state.enqueue } }));
vi.mock("../modules/Website/websitePublicationDelivery.service", () => ({ WebsitePublicationDeliveryService: { attemptImmediate: state.deliver } }));
vi.mock("../lib/cache/authRuntimeCache", () => ({
    invalidateRuntimeAdminAccessContext: vi.fn(async () => undefined),
    invalidateRuntimeSubscriptionForAdmin: vi.fn(async () => undefined),
}));

vi.mock("../lib/utils/createNotification", () => ({
    createNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middlewares/checkSubscription", () => ({
    invalidateSubscriptionAccessCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../modules/Entitlement/tenantAccessResolver.service", () => ({
    TenantAccessResolver: {
        invalidate: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock("../modules/Website/websiteProjectionCache.service", () => ({
    WebsiteProjectionCacheService: {
        invalidateAdminWebsite: vi.fn().mockResolvedValue(undefined),
    },
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
    state.updateMany.mockResolvedValue({ count: 1 });
    state.enqueue.mockResolvedValue({ id: "event-1", payload: {} });
    state.deliver.mockResolvedValue({ delivered: true });
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
            .mockResolvedValueOnce([{ id: "sub-1", adminId: "admin-1", admin: { userId: "user-1" } }]) // paid query
            .mockResolvedValueOnce([]); // trial query

        await runSubscriptionExpiryJob();

        expect(mockPrisma.subscription.updateMany).toHaveBeenCalledWith({
            where: { id: "sub-1", status: "ACTIVE", isTrial: false, currentPeriodEnd: { lte: expect.any(Date) } },
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
            .mockResolvedValueOnce([{ id: "sub-2", adminId: "admin-2", admin: { userId: "user-2" } }]); // trial query

        await runSubscriptionExpiryJob();

        expect(mockPrisma.subscription.updateMany).toHaveBeenCalledWith({
            where: { id: "sub-2", status: "ACTIVE", isTrial: true, trialEndsAt: { lte: expect.any(Date) } },
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
                { id: "sub-paid-1", adminId: "admin-1", admin: { userId: "user-1" } },
                { id: "sub-paid-2", adminId: "admin-2", admin: { userId: "user-2" } },
            ])
            .mockResolvedValueOnce([{ id: "sub-trial-1", adminId: "admin-3", admin: { userId: "user-3" } }]);

        await runSubscriptionExpiryJob();

        // Separate conditional updateMany calls — one per branch — each scoped to its
        // own record, never a blind update that can expire a concurrent renewal.
        expect(mockPrisma.subscription.updateMany).toHaveBeenCalledTimes(3);
        expect(mockPrisma.subscription.updateMany).toHaveBeenNthCalledWith(1, {
            where: { id: "sub-paid-1", status: "ACTIVE", isTrial: false, currentPeriodEnd: { lte: expect.any(Date) } },
            data: { status: "EXPIRED" },
        });
        expect(mockPrisma.subscription.updateMany).toHaveBeenNthCalledWith(3, {
            where: { id: "sub-trial-1", status: "ACTIVE", isTrial: true, trialEndsAt: { lte: expect.any(Date) } },
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
                currentPeriodEnd: { lte: expect.any(Date) },
            },
            select: { id: true, adminId: true, admin: { select: { userId: true } } },
        });
    });

    it("queries only ACTIVE trial subscriptions with an elapsed trialEndsAt for the trial branch", async () => {
        mockPrisma.subscription.findMany.mockResolvedValue([]);

        await runSubscriptionExpiryJob();

        expect(mockPrisma.subscription.findMany).toHaveBeenNthCalledWith(2, {
            where: {
                status: "ACTIVE",
                isTrial: true,
                trialEndsAt: { lte: expect.any(Date) },
            },
            select: { id: true, adminId: true, admin: { select: { userId: true } } },
        });
    });

    it("still expires subscriptions even if pushing a notification for one of them fails", async () => {
        mockPrisma.subscription.findMany
            .mockResolvedValueOnce([{ id: "sub-1", adminId: "admin-1", admin: { userId: "user-1" } }])
            .mockResolvedValueOnce([]);
        // createNotification failures are swallowed with .catch(() => {}) at the
        // call site specifically so a notification-delivery problem can never
        // block the actual expiry write — assert the job still resolves cleanly.
        mockCreateNotification.mockRejectedValueOnce(new Error("socket down"));

        await expect(runSubscriptionExpiryJob()).resolves.toBeUndefined();
        expect(mockPrisma.subscription.updateMany).toHaveBeenCalledTimes(1);
    });

    it("does not notify or enqueue a subscription that was concurrently renewed", async () => {
        state.findMany.mockResolvedValueOnce([{ id: "renewed", adminId: "admin-1", admin: { userId: "user-1" } }]).mockResolvedValueOnce([]);
        state.updateMany.mockResolvedValue({ count: 0 });
        await runSubscriptionExpiryJob();
        expect(state.enqueue).not.toHaveBeenCalled();
        expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it("propagates a database error instead of silently swallowing it", async () => {
        const dbError = new Error("connection terminated unexpectedly");
        mockPrisma.subscription.findMany.mockRejectedValueOnce(dbError);

        await expect(runSubscriptionExpiryJob()).rejects.toThrow(dbError);
    });
});
