/**
 * superAdmin.service.paymentProof.test.ts
 *
 * Coverage for the payment-proof review flow super-admins use at the end of
 * the manual-payment path (tenant uploads proof -> super-admin approves or
 * rejects it):
 *
 *   approvePaymentProof(billingId, { periodMonths, note })
 *   rejectPaymentProof(billingId, { reason })
 *
 * Focus areas:
 *   - The happy path actually extends the subscription and flips billing
 *     status, atomically (via prisma.$transaction), and fires a real-time
 *     notification to the tenant.
 *   - "Bypass attempt" guards: a billing record can only be approved/
 *     rejected once. Without the PENDING-only check, someone re-hitting the
 *     approve endpoint on an already-approved (or already-rejected) record
 *     could re-extend a subscription's period repeatedly, or "launder" a
 *     rejected proof into an approval on a second call.
 *   - Phase-6 plan changes keep the live subscription untouched until approval.
 *     Rejection only marks the checkout as REJECTED so the tenant can submit a
 *     corrected proof; approval activates the target plan atomically.
 *   - Legacy pre-Phase-6 PENDING_PAYMENT proofs remain supported.
 *
 * Heavy/unrelated module-level dependencies of superAdmin.service.ts
 * (better-auth client construction, email sending, Vercel's waitUntil,
 * platform config) are stubbed purely so the module can be imported in a
 * test environment with no real network/DB — none of them are exercised by
 * the two functions under test here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma/prisma", () => {
    const prismaMock = {
        billingHistory: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        subscription: {
            update: vi.fn(),
        },
        pendingPlanChange: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        couponUsage: {
            findUnique: vi.fn(),
            create: vi.fn(),
        },
        coupon: { update: vi.fn() },
        $queryRaw: vi.fn().mockResolvedValue([]),
        $transaction: vi.fn(),
    };
    prismaMock.$transaction.mockImplementation((work: unknown) =>
        typeof work === "function"
            ? (work as (tx: typeof prismaMock) => unknown)(prismaMock)
            : Promise.all(work as Promise<unknown>[]),
    );
    return { prisma: prismaMock };
});

vi.mock("../../lib/utils/createNotification", () => ({
    createNotification: vi.fn().mockResolvedValue(undefined),
}));

// Unrelated module-load-time dependencies of superAdmin.service.ts — stubbed
// so importing the service doesn't try to construct a real better-auth
// client, send real email, etc. None of these are called by approve/reject.
vi.mock("../../lib/auth", () => ({ auth: {} }));
vi.mock("../../lib/utils/sendEmailSafely", () => ({
    sendEmailSafely: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn((p: unknown) => p) }));
vi.mock("../Admin/admin.service", () => ({
    adminService: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("../../lib/utils/platformConfig", () => ({
    getPlatformConfig: vi.fn(),
    updatePlatformConfig: vi.fn(),
}));
vi.mock("../../lib/constants/featureGateLabels", () => ({
    findNearMissFeatureLabels: vi.fn(() => []),
}));
vi.mock("../../middlewares/checkSubscription", () => ({
    invalidateSubscriptionAccessCache: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../../lib/prisma/prisma";
import { createNotification } from "../../lib/utils/createNotification";
import { superAdminService } from "./superAdmin.service";

const mockPrisma = prisma as unknown as {
    billingHistory: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    };
    subscription: { update: ReturnType<typeof vi.fn> };
    pendingPlanChange: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    };
    couponUsage: {
        findUnique: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
    };
    coupon: { update: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
};
const mockCreateNotification = createNotification as ReturnType<typeof vi.fn>;

const BILLING_ID = "billing-1";
const SUB_ID = "sub-1";
const ADMIN_ID = "admin-1";

function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 86_400_000);
}

function pendingRecord(overrides: Partial<Record<string, unknown>> = {}) {
    // NOTE: `subscription` is pulled out and merged separately from the
    // rest of `overrides` — spreading the whole `overrides` object at the
    // end (after `subscription` is already set below) would otherwise
    // clobber the carefully-merged subscription object with the raw,
    // unmerged override, silently dropping `id`/`adminId` whenever a test
    // only meant to override one nested field (e.g. `currentPeriodEnd`).
    const { subscription: subscriptionOverride, ...rest } = overrides;
    return {
        id: BILLING_ID,
        status: "PENDING",
        paymentProofUrl: "https://cloudinary.com/proof.jpg",
        note: null,
        pendingPlanChange: null,
        subscription: {
            id: SUB_ID,
            adminId: ADMIN_ID,
            currentPeriodEnd: daysFromNow(5),
            admin: { userId: "user-1" },
            ...((subscriptionOverride as object) ?? {}),
        },
        ...rest,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation((work: unknown) =>
        typeof work === "function"
            ? (work as (tx: typeof mockPrisma) => unknown)(mockPrisma)
            : Promise.all(work as Promise<unknown>[]),
    );
});

describe("approvePaymentProof", () => {
    it("throws 404 when the billing record doesn't exist", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue(null);

        await expect(
            superAdminService.approvePaymentProof(BILLING_ID, {}),
        ).rejects.toMatchObject({ statusCode: 404 });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("throws 400 and does not touch billing/subscription if there's no attached proof", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue(
            pendingRecord({ paymentProofUrl: null }),
        );

        await expect(
            superAdminService.approvePaymentProof(BILLING_ID, {}),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    // ── Bypass-attempt guard ────────────────────────────────────────────────
    it("bypass attempt: refuses to re-approve a record that's already PAID (blocks double-extension)", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue(
            pendingRecord({ status: "PAID" }),
        );

        await expect(
            superAdminService.approvePaymentProof(BILLING_ID, {}),
        ).rejects.toMatchObject({
            statusCode: 400,
            message: expect.stringMatching(/only pending proofs can be approved/i),
        });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it("bypass attempt: refuses to approve a record that was already rejected (FAILED)", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue(
            pendingRecord({ status: "FAILED" }),
        );

        await expect(
            superAdminService.approvePaymentProof(BILLING_ID, {}),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("on approval: marks the billing record PAID, activates the subscription, and extends by 1 month by default", async () => {
        const periodEnd = daysFromNow(5);
        mockPrisma.billingHistory.findUnique.mockResolvedValue(
            pendingRecord({ subscription: { currentPeriodEnd: periodEnd } }),
        );
        mockPrisma.billingHistory.update.mockResolvedValue({ id: BILLING_ID, status: "PAID" });
        mockPrisma.subscription.update.mockResolvedValue({
            id: SUB_ID,
            adminId: ADMIN_ID,
            status: "ACTIVE",
        });

        await superAdminService.approvePaymentProof(BILLING_ID, {});

        expect(mockPrisma.billingHistory.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: BILLING_ID },
                data: expect.objectContaining({ status: "PAID", paidAt: expect.any(Date) }),
            }),
        );

        const subUpdateArg = mockPrisma.subscription.update.mock.calls[0][0];
        expect(subUpdateArg.where).toEqual({ id: SUB_ID });
        expect(subUpdateArg.data.status).toBe("ACTIVE");
        expect(subUpdateArg.data.isTrial).toBe(false);
        expect(subUpdateArg.data.cancelAtPeriodEnd).toBe(false);
        expect(subUpdateArg.data.canceledAt).toBeNull();
        // Extended from the still-future currentPeriodEnd, not from "now".
        const expectedEnd = new Date(periodEnd);
        expectedEnd.setMonth(expectedEnd.getMonth() + 1);
        expect(subUpdateArg.data.currentPeriodEnd.getTime()).toBe(expectedEnd.getTime());

        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        expect(mockCreateNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                adminId: ADMIN_ID,
                type: "SUBSCRIPTION",
                relatedId: SUB_ID,
                title: expect.stringMatching(/payment approved/i),
            }),
        );
    });

    it("extends from today (not the stale past date) when the current period has already lapsed", async () => {
        const lapsedEnd = daysFromNow(-10);
        mockPrisma.billingHistory.findUnique.mockResolvedValue(
            pendingRecord({ subscription: { currentPeriodEnd: lapsedEnd } }),
        );
        mockPrisma.billingHistory.update.mockResolvedValue({});
        mockPrisma.subscription.update.mockResolvedValue({ id: SUB_ID, adminId: ADMIN_ID });

        const before = Date.now();
        await superAdminService.approvePaymentProof(BILLING_ID, {});

        const subUpdateArg = mockPrisma.subscription.update.mock.calls[0][0];
        const newEnd: Date = subUpdateArg.data.currentPeriodEnd;
        // ~1 month from "now" (test run time), not 1 month from the lapsed date.
        const minExpected = new Date(before);
        minExpected.setMonth(minExpected.getMonth() + 1);
        expect(newEnd.getTime()).toBeGreaterThan(minExpected.getTime() - 5_000);
    });

    it("honours a custom periodMonths (e.g. quarterly manual payment)", async () => {
        const periodEnd = daysFromNow(5);
        mockPrisma.billingHistory.findUnique.mockResolvedValue(
            pendingRecord({ subscription: { currentPeriodEnd: periodEnd } }),
        );
        mockPrisma.billingHistory.update.mockResolvedValue({});
        mockPrisma.subscription.update.mockResolvedValue({ id: SUB_ID, adminId: ADMIN_ID });

        await superAdminService.approvePaymentProof(BILLING_ID, { periodMonths: 3 });

        const subUpdateArg = mockPrisma.subscription.update.mock.calls[0][0];
        const expectedEnd = new Date(periodEnd);
        expectedEnd.setMonth(expectedEnd.getMonth() + 3);
        expect(subUpdateArg.data.currentPeriodEnd.getTime()).toBe(expectedEnd.getTime());
    });
});

describe("Phase-6 pending plan checkout approval", () => {
    it("activates the target yearly plan only when the proof is approved", async () => {
        const checkout = {
            id: "checkout-1",
            status: "UNDER_REVIEW",
            targetPlanId: "plan-yearly",
            couponId: null,
            quotedAmount: 499,
            targetPlan: {
                id: "plan-yearly",
                interval: "YEARLY",
                subscriptionPlanId: "growth-plan",
                subscriptionPlan: { name: "GROWTH" },
            },
        };
        const record = pendingRecord({
            pendingPlanChange: checkout,
            subscription: {
                currentPeriodEnd: daysFromNow(20),
                admin: { userId: "user-1" },
            },
        });
        mockPrisma.billingHistory.findUnique.mockResolvedValue(record);
        mockPrisma.pendingPlanChange.findUnique.mockResolvedValue(checkout);
        mockPrisma.billingHistory.update.mockResolvedValue({ id: BILLING_ID, status: "PAID" });
        mockPrisma.subscription.update.mockResolvedValue({
            id: SUB_ID,
            adminId: ADMIN_ID,
            status: "ACTIVE",
        });
        mockPrisma.pendingPlanChange.update.mockResolvedValue({
            ...checkout,
            status: "APPROVED",
        });

        const before = new Date();
        await superAdminService.approvePaymentProof(BILLING_ID, {});

        expect(mockPrisma.subscription.update).toHaveBeenCalledTimes(1);
        const update = mockPrisma.subscription.update.mock.calls[0][0];
        expect(update.data).toEqual(
            expect.objectContaining({
                planId: "plan-yearly",
                subscriptionPlanId: "growth-plan",
                totalCost: 499,
                status: "ACTIVE",
                isTrial: false,
            }),
        );
        const periodEnd = update.data.currentPeriodEnd as Date;
        expect(periodEnd.getFullYear()).toBeGreaterThanOrEqual(before.getFullYear() + 1);
        expect(mockPrisma.pendingPlanChange.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "checkout-1" },
                data: expect.objectContaining({ status: "APPROVED" }),
            }),
        );
    });

    it("rejects a checkout proof without touching the live subscription", async () => {
        const checkout = {
            id: "checkout-1",
            status: "UNDER_REVIEW",
            targetPlanId: "plan-monthly",
        };
        const record = pendingRecord({ pendingPlanChange: checkout });
        mockPrisma.billingHistory.findUnique.mockResolvedValue(record);
        mockPrisma.billingHistory.update.mockResolvedValue({ id: BILLING_ID, status: "FAILED" });
        mockPrisma.pendingPlanChange.update.mockResolvedValue({
            ...checkout,
            status: "REJECTED",
        });

        await superAdminService.rejectPaymentProof(BILLING_ID, {
            reason: "Transaction reference is unreadable",
        });

        expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
        expect(mockPrisma.pendingPlanChange.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "checkout-1" },
                data: expect.objectContaining({
                    status: "REJECTED",
                    rejectionReason: "Transaction reference is unreadable",
                }),
            }),
        );
    });
});

describe("rejectPaymentProof", () => {
    function pendingRecordWithFullSubscription() {
        return {
            id: BILLING_ID,
            status: "PENDING",
            paymentProofUrl: "https://cloudinary.com/proof.jpg",
            note: null,
            pendingPlanChange: null,
            subscription: {
                id: SUB_ID,
                adminId: ADMIN_ID,
                status: "PENDING_PAYMENT",
                subscriptionPlan: { name: "Growth" },
                admin: { businessName: "Acme Cleaning", user: { name: "Jane", email: "jane@acme.com" } },
            },
        };
    }

    it("throws 404 when the billing record doesn't exist", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue(null);

        await expect(
            superAdminService.rejectPaymentProof(BILLING_ID, {}),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    // ── Bypass-attempt guard ────────────────────────────────────────────────
    it("bypass attempt: refuses to reject a record that's already been approved (PAID)", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue({
            ...pendingRecordWithFullSubscription(),
            status: "PAID",
        });

        await expect(
            superAdminService.rejectPaymentProof(BILLING_ID, {}),
        ).rejects.toMatchObject({
            statusCode: 400,
            message: expect.stringMatching(/only pending proofs can be rejected/i),
        });
        expect(mockPrisma.billingHistory.update).not.toHaveBeenCalled();
    });

    it("throws 400 when there's no attached proof to reject", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue({
            ...pendingRecordWithFullSubscription(),
            paymentProofUrl: null,
        });

        await expect(
            superAdminService.rejectPaymentProof(BILLING_ID, {}),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("marks the record FAILED with the given reason and does NOT touch the subscription", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue(
            pendingRecordWithFullSubscription(),
        );
        mockPrisma.billingHistory.update.mockResolvedValue({
            id: BILLING_ID,
            status: "FAILED",
            subscription: { adminId: ADMIN_ID, id: SUB_ID },
        });

        await superAdminService.rejectPaymentProof(BILLING_ID, {
            reason: "Screenshot doesn't match the invoice amount",
        });

        expect(mockPrisma.billingHistory.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: BILLING_ID },
                data: expect.objectContaining({
                    status: "FAILED",
                    note: expect.stringContaining("Screenshot doesn't match the invoice amount"),
                }),
            }),
        );
        // Legacy rejection still leaves the live subscription exactly as-is.
        expect(mockPrisma.subscription.update).not.toHaveBeenCalled();

        expect(mockCreateNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                adminId: ADMIN_ID,
                type: "SUBSCRIPTION",
                title: expect.stringMatching(/rejected/i),
                message: expect.stringContaining("Screenshot doesn't match the invoice amount"),
            }),
        );
    });

    it("falls back to a generic rejection note when no reason is given", async () => {
        mockPrisma.billingHistory.findUnique.mockResolvedValue(
            pendingRecordWithFullSubscription(),
        );
        mockPrisma.billingHistory.update.mockResolvedValue({
            id: BILLING_ID,
            status: "FAILED",
        });

        await superAdminService.rejectPaymentProof(BILLING_ID, {});

        expect(mockPrisma.billingHistory.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ note: expect.stringMatching(/rejected/i) }),
            }),
        );
        expect(mockCreateNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringMatching(/clearer or corrected proof/i),
            }),
        );
    });
});
