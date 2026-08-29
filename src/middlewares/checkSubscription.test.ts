/**
 * checkSubscription.test.ts
 *
 * Unit tests for the two billing gates in checkSubscription.ts:
 *   - checkSubscription  — router-level status gate (blocks expired/suspended/
 *                          cancelled ADMIN accounts)
 *   - checkFeature(key)  — per-route plan-feature gate
 *
 * Both gates share the same "fail open for anyone who isn't an authenticated
 * ADMIN" design (no token, bad token, STAFF/SUPER_ADMIN role, no admin
 * profile, no subscription -> next() with no error) because checkAuth is
 * responsible for actually rejecting unauthenticated/unauthorized requests;
 * this middleware only ever *adds* a billing-based block on top of that for
 * ADMIN accounts that do have a subscription row to evaluate.
 *
 * prisma and jwtUtils are mocked so these tests run with no real database or
 * JWT secret — they only exercise the gate's own branching logic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

vi.mock("../config/redis", () => ({
    default: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => "OK"),
        setex: vi.fn(async () => "OK"),
        del: vi.fn(async () => 1),
    },
}));

vi.mock("../lib/prisma/prisma", () => ({
    prisma: {
        user: { findUnique: vi.fn() },
        adminProfile: { findFirst: vi.fn() },
        subscription: { findFirst: vi.fn() },
    },
}));

vi.mock("../lib/utils/jwt", () => ({
    jwtUtils: {
        verifyToken: vi.fn(),
        createToken: vi.fn(),
        decodeToken: vi.fn(),
    },
}));

import { prisma } from "../lib/prisma/prisma";
import { jwtUtils } from "../lib/utils/jwt";
import { checkFeature, checkSubscription } from "./checkSubscription";

const mockPrisma = prisma as unknown as {
    user: { findUnique: ReturnType<typeof vi.fn> };
    adminProfile: { findFirst: ReturnType<typeof vi.fn> };
    subscription: { findFirst: ReturnType<typeof vi.fn> };
};
const mockVerifyToken = jwtUtils.verifyToken as ReturnType<typeof vi.fn>;

const ADMIN_ID = "user-admin-1";
const ADMIN_PROFILE_ID = "admin-profile-1";

function makeReq(opts: { bearer?: string; cookie?: string } = {}): Request {
    return {
        headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
        cookies: opts.cookie ? { accessToken: opts.cookie } : {},
    } as unknown as Request;
}

function makeRes(): Response {
    return {} as Response;
}

function makeNext() {
    return vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
}

function verifiesAsAdmin(userId = ADMIN_ID) {
    mockVerifyToken.mockReturnValue({
        success: true,
        data: { userId, role: "ADMIN" },
    });
}

function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 86_400_000);
}

function mockUserContext(opts: {
    status?: string;
    adminId?: string | null;
    subscription?: {
        status?: string;
        isTrial?: boolean;
        trialEndsAt?: Date | string | null;
        currentPeriodEnd?: Date | string | null;
        cancelAtPeriodEnd?: boolean;
        subscriptionPlan?: { id?: string; name?: string; features?: unknown[] } | null;
    } | null;
} = {}) {
    const { status = "ACTIVE", adminId = ADMIN_PROFILE_ID, subscription } = opts;
    if (adminId === null) {
        mockPrisma.user.findUnique.mockResolvedValue({ status, admin: null });
        return;
    }
    if (subscription === null) {
        mockPrisma.user.findUnique.mockResolvedValue({
            status,
            admin: { id: adminId, subscription: [] },
        });
        return;
    }
    const sub = {
        status: subscription?.status ?? "ACTIVE",
        isTrial: subscription?.isTrial ?? false,
        trialEndsAt: subscription?.trialEndsAt ? new Date(subscription.trialEndsAt) : null,
        currentPeriodEnd: subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        subscriptionPlan: subscription?.subscriptionPlan === null ? null : {
            id: subscription?.subscriptionPlan?.id ?? "plan-1",
            name: subscription?.subscriptionPlan?.name ?? "Growth",
            features: subscription?.subscriptionPlan?.features ?? [
                JSON.stringify({ label: "Coupons", included: true }),
                JSON.stringify({ label: "Auto Dispatch", included: true }),
            ],
        },
    };
    mockPrisma.user.findUnique.mockResolvedValue({
        status,
        admin: { id: adminId, subscription: [sub] },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("checkSubscription (router-level status gate)", () => {
    it("passes through with no error when no access token is present", async () => {
        const next = makeNext();
        await checkSubscription(makeReq(), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
        expect(mockVerifyToken).not.toHaveBeenCalled();
    });

    it("passes through when the access token fails verification", async () => {
        mockVerifyToken.mockReturnValue({ success: false });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "bad.token" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("reads the accessToken cookie over the Authorization header when both are present", async () => {
        mockVerifyToken.mockReturnValue({ success: false });
        const next = makeNext();

        await checkSubscription(
            makeReq({ bearer: "header-token", cookie: "cookie-token" }),
            makeRes(),
            next,
        );

        expect(mockVerifyToken).toHaveBeenCalledWith(
            "cookie-token",
            expect.anything(),
        );
    });

    it("falls back to the accessToken cookie when no Authorization header is present", async () => {
        mockVerifyToken.mockReturnValue({ success: false });
        const next = makeNext();

        await checkSubscription(makeReq({ cookie: "cookie-token" }), makeRes(), next);

        expect(mockVerifyToken).toHaveBeenCalledWith(
            "cookie-token",
            expect.anything(),
        );
    });

    it("exempts non-ADMIN roles (e.g. STAFF) without touching the database", async () => {
        mockVerifyToken.mockReturnValue({
            success: true,
            data: { userId: "staff-1", role: "STAFF" },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("exempts SUPER_ADMIN without touching the database", async () => {
        mockVerifyToken.mockReturnValue({
            success: true,
            data: { userId: "sa-1", role: "SUPER_ADMIN" },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("blocks a SUSPENDED admin user account with 403", async () => {
        verifiesAsAdmin();
        mockUserContext({ status: "SUSPENDED" });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 403,
                message: expect.stringMatching(/suspended/i),
            }),
        );
    });

    it("blocks a DELETED admin user account with 403", async () => {
        verifiesAsAdmin();
        mockUserContext({ status: "DELETED" });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 403,
                message: expect.stringMatching(/deleted/i),
            }),
        );
    });

    it("passes through when the admin has no AdminProfile yet", async () => {
        verifiesAsAdmin();
        mockUserContext({ adminId: null });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("passes through when the admin has no subscription row at all", async () => {
        verifiesAsAdmin();
        mockUserContext({ subscription: null });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("blocks with 402 when the subscription status is SUSPENDED", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "SUSPENDED",
                isTrial: false,
                trialEndsAt: null,
                currentPeriodEnd: daysFromNow(20),
                cancelAtPeriodEnd: false,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({ statusCode: 402 }),
        );
    });

    it("blocks with 402 when the subscription status is EXPIRED", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "EXPIRED",
                isTrial: false,
                trialEndsAt: null,
                currentPeriodEnd: daysFromNow(20),
                cancelAtPeriodEnd: false,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 402,
                message: expect.stringMatching(/expired/i),
            }),
        );
    });

    it("blocks with 402 when the subscription status is PENDING_PAYMENT", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "PENDING_PAYMENT",
                isTrial: false,
                trialEndsAt: null,
                currentPeriodEnd: daysFromNow(20),
                cancelAtPeriodEnd: false,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 402,
                message: expect.stringMatching(/under review/i),
            }),
        );
    });

    it("blocks with 402 when the subscription status is CANCELLED (regression guard)", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "CANCELLED",
                isTrial: false,
                trialEndsAt: null,
                currentPeriodEnd: daysFromNow(20),
                cancelAtPeriodEnd: false,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 402,
                message: expect.stringMatching(/cancelled/i),
            }),
        );
    });

    it("blocks with 402 when an active trial's trialEndsAt is in the past", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "ACTIVE",
                isTrial: true,
                trialEndsAt: daysFromNow(-1),
                currentPeriodEnd: null,
                cancelAtPeriodEnd: false,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 402,
                message: expect.stringMatching(/trial has ended/i),
            }),
        );
    });

    it("allows a trial that has not ended yet", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "ACTIVE",
                isTrial: true,
                trialEndsAt: daysFromNow(3),
                currentPeriodEnd: null,
                cancelAtPeriodEnd: false,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("blocks with 402 and a 'renew' message when a non-trial billing period has ended naturally", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "ACTIVE",
                isTrial: false,
                trialEndsAt: null,
                currentPeriodEnd: daysFromNow(-1),
                cancelAtPeriodEnd: false,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 402,
                message: expect.stringMatching(/renew/i),
            }),
        );
    });

    it("blocks with 402 and a 'resubscribe' message when a self-serve cancelAtPeriodEnd subscription's period has elapsed", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "ACTIVE",
                isTrial: false,
                trialEndsAt: null,
                currentPeriodEnd: daysFromNow(-1),
                cancelAtPeriodEnd: true,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 402,
                message: expect.stringMatching(/resubscribe/i),
            }),
        );
    });

    it("allows an ACTIVE, non-trial subscription whose current period has not ended", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                status: "ACTIVE",
                isTrial: false,
                trialEndsAt: null,
                currentPeriodEnd: daysFromNow(20),
                cancelAtPeriodEnd: false,
            },
        });
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("forwards unexpected database errors to next(error) instead of throwing", async () => {
        verifiesAsAdmin();
        const dbError = new Error("connection terminated unexpectedly");
        mockPrisma.user.findUnique.mockRejectedValue(dbError);
        const next = makeNext();

        await checkSubscription(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(dbError);
    });
});

describe("checkFeature(featureKey)", () => {
    it("passes through with no error when no access token is present", async () => {
        const next = makeNext();
        await checkFeature("coupons")(makeReq(), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("passes through when the token fails verification", async () => {
        mockVerifyToken.mockReturnValue({ success: false });
        const next = makeNext();

        await checkFeature("coupons")(makeReq({ bearer: "bad" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("exempts non-ADMIN roles without touching the database", async () => {
        mockVerifyToken.mockReturnValue({
            success: true,
            data: { userId: "staff-1", role: "STAFF" },
        });
        const next = makeNext();

        await checkFeature("coupons")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
        expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("passes through when the admin has no AdminProfile yet", async () => {
        verifiesAsAdmin();
        mockUserContext({ adminId: null });
        const next = makeNext();

        await checkFeature("coupons")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("passes through when the admin has no subscription row", async () => {
        verifiesAsAdmin();
        mockUserContext({ subscription: null });
        const next = makeNext();

        await checkFeature("coupons")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("allows access when the plan includes the feature flagged as included", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                subscriptionPlan: {
                    features: [
                        JSON.stringify({ label: "Coupons", included: true }),
                        JSON.stringify({ label: "Auto Dispatch", included: false }),
                    ],
                },
            },
        });
        const next = makeNext();

        await checkFeature("coupons")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("blocks with 403 when the plan has the feature but marked as not included", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                subscriptionPlan: {
                    features: [
                        JSON.stringify({ label: "Auto Dispatch", included: false }),
                    ],
                },
            },
        });
        const next = makeNext();

        await checkFeature("auto-dispatch")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: 403,
                message: expect.stringMatching(/does not include 'auto-dispatch'/i),
            }),
        );
    });

    it("blocks with 403 when the plan does not have the feature at all", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                subscriptionPlan: { features: [] },
            },
        });
        const next = makeNext();

        await checkFeature("recurring bookings")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({ statusCode: 403 }),
        );
    });

    it("blocks with 403 when subscriptionPlan is missing entirely", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: { subscriptionPlan: null },
        });
        const next = makeNext();

        await checkFeature("coupons")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({ statusCode: 403 }),
        );
    });

    it("matches feature labels stored as plain (non-JSON) strings, defaulting them to included", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                subscriptionPlan: { features: ["Coupons"] },
            },
        });
        const next = makeNext();

        await checkFeature("coupons")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("normalises case and punctuation so 'auto-dispatch' matches a plan label of 'Auto Dispatch'", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                subscriptionPlan: {
                    features: [JSON.stringify({ label: "Auto Dispatch", included: true })],
                },
            },
        });
        const next = makeNext();

        await checkFeature("auto-dispatch")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("normalises trailing punctuation in the feature key (regression guard)", async () => {
        verifiesAsAdmin();
        mockUserContext({
            subscription: {
                subscriptionPlan: {
                    features: [JSON.stringify({ label: "Auto Dispatch", included: true })],
                },
            },
        });
        const next = makeNext();

        await checkFeature("Auto-Dispatch!!")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith();
    });

    it("forwards unexpected database errors to next(error) instead of throwing", async () => {
        verifiesAsAdmin();
        const dbError = new Error("connection terminated unexpectedly");
        mockPrisma.user.findUnique.mockRejectedValue(dbError);
        const next = makeNext();

        await checkFeature("coupons")(makeReq({ bearer: "t" }), makeRes(), next);

        expect(next).toHaveBeenCalledWith(dbError);
    });
});
