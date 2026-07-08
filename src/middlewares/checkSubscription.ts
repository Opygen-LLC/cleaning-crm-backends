/**
 * checkSubscription.ts  — Phase 1 Production Version
 *
 * Two layers of enforcement:
 *  1. STATUS GATE: blocks ADMIN users whose subscription is EXPIRED/SUSPENDED/PENDING_PAYMENT
 *  2. FEATURE GATE: checkFeature(featureKey) middleware factory for per-route feature locking
 *
 * STAFF and SUPER_ADMIN are exempt from both gates.
 */

import { NextFunction, Request, Response } from "express";
import status from "http-status";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import AppError from "../errorHelper/AppError";
import { jwtUtils } from "../lib/utils/jwt";
import { ACCESS_TOKEN_SECRET } from "../config/ENV";
import { CookieUtils } from "../lib/utils/cookie";

function getAccessToken(req: Request): string | undefined {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer "))
        return authHeader.slice("Bearer ".length).trim();
    return CookieUtils.getCookie(req, "accessToken");
}

// ─── Status gate (mounted at router level) ────────────────────────────────────
export const checkSubscription = async (
    req: Request,
    _res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const accessToken = getAccessToken(req);
        if (!accessToken) return next();

        const verified = jwtUtils.verifyToken(accessToken, ACCESS_TOKEN_SECRET);
        if (!verified.success || !verified.data) return next();

        const { userId, role } = verified.data as {
            userId: string;
            role: string;
        };
        if (role !== UserRole.ADMIN) return next();

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { status: true },
        });
        if (user?.status === AccountStatus.SUSPENDED)
            throw new AppError(
                status.FORBIDDEN,
                "Your account has been suspended. Please contact support.",
            );
        if (user?.status === AccountStatus.DELETED)
            throw new AppError(
                status.FORBIDDEN,
                "This account has been deleted.",
            );

        const admin = await prisma.adminProfile.findFirst({
            where: { userId },
            select: { id: true },
        });
        if (!admin) return next();

        const sub = await prisma.subscription.findFirst({
            where: { adminId: admin.id },
            select: {
                status: true,
                isTrial: true,
                trialEndsAt: true,
                currentPeriodEnd: true,
                cancelAtPeriodEnd: true,
            },
            orderBy: { createdAt: "desc" },
        });
        if (!sub) return next();

        const now = new Date();
        if (sub.status === "SUSPENDED")
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your account has been suspended. Please contact support or submit a payment proof.",
            );
        if (sub.status === "EXPIRED")
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your subscription has expired. Please renew to continue using the platform.",
            );
        if (sub.status === "PENDING_PAYMENT")
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your payment proof is under review. Your account will be reactivated once approved.",
            );
        // BUGFIX: CANCELLED was never checked here. superAdmin.service.ts'
        // cancelSubscription() sets status: CANCELLED immediately (no grace
        // period) — that's distinct from cancelAtPeriodEnd (self-serve
        // cancellation, which keeps status ACTIVE until currentPeriodEnd).
        // Without this branch a super-admin-cancelled subscription kept full
        // API access forever even though the frontend's useGateMap already
        // treats "Cancelled" as hasActiveAccess === false, so the sidebar
        // showed everything locked while the API happily served requests.
        if (sub.status === "CANCELLED")
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your subscription has been cancelled. Please subscribe to a plan to continue using the platform.",
            );
        if (sub.isTrial && sub.trialEndsAt && sub.trialEndsAt < now)
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your free trial has ended. Please upgrade to continue.",
            );
        // Covers both the natural end-of-billing-period case AND a
        // self-serve cancelAtPeriodEnd cancellation once its period elapses
        // (status stays ACTIVE until then by design — see subscription.service.ts).
        if (!sub.isTrial && sub.currentPeriodEnd && sub.currentPeriodEnd < now)
            throw new AppError(
                status.PAYMENT_REQUIRED,
                sub.cancelAtPeriodEnd
                    ? "Your subscription was cancelled and your billing period has ended. Please resubscribe to continue."
                    : "Your billing period has ended. Please renew your subscription.",
            );

        next();
    } catch (error) {
        next(error);
    }
};

// ─── Feature gate middleware factory (per-route) ──────────────────────────────
/**
 * checkFeature("auto-dispatch")
 *
 * Returns Express middleware that returns 403 if the admin's plan does not
 * include the given feature string (case-insensitive, normalised).
 *
 * Usage:
 *   router.post("/:id/dispatch", checkAuth(UserRole.ADMIN), checkFeature("auto-dispatch"), jobDispatchController.dispatchJob);
 *   router.post("/",             checkAuth(UserRole.ADMIN), checkFeature("coupons"),       couponController.create);
 *   router.get("/",              checkAuth(UserRole.ADMIN), checkFeature("recurring bookings"), recurringBookingController.getAll);
 */
export function checkFeature(featureKey: string) {
    // NOTE: .trim() must run again *after* the replace, not just before it.
    // A featureKey with leading/trailing punctuation (e.g. "Auto-Dispatch!")
    // gets that punctuation collapsed into a boundary space by the regex
    // (-> "auto dispatch "), which then fails to match a cleanly-normalised
    // plan label ("auto dispatch") and silently locks a paying admin out of
    // a feature their plan includes. Caught by the middleware's own test
    // suite (see checkSubscription.test.ts — "normalises punctuation").
    const normKey = featureKey
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    return async (req: Request, _res: Response, next: NextFunction) => {
        try {
            const accessToken = getAccessToken(req);
            if (!accessToken) return next();

            const verified = jwtUtils.verifyToken(
                accessToken,
                ACCESS_TOKEN_SECRET,
            );
            if (!verified.success || !verified.data) return next();

            const { userId, role } = verified.data as {
                userId: string;
                role: string;
            };
            if (role !== UserRole.ADMIN) return next();

            const admin = await prisma.adminProfile.findFirst({
                where: { userId },
                select: { id: true },
            });
            if (!admin) return next();

            const sub = await prisma.subscription.findFirst({
                where: { adminId: admin.id },
                include: { subscriptionPlan: { select: { features: true } } },
                orderBy: { createdAt: "desc" },
            });
            if (!sub) return next();

            const includedRaw = sub.subscriptionPlan?.features ?? [];
            const included = includedRaw.map((f) => {
                try {
                    return JSON.parse(f) as {
                        label: string;
                        included: boolean;
                    };
                } catch {
                    return { label: f, included: true };
                }
            });
            const hasFeature = included.some(
                (f) =>
                    f.included &&
                    f.label
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, " ")
                        .trim() === normKey,
            );

            if (!hasFeature) {
                throw new AppError(
                    status.FORBIDDEN,
                    `Your current plan does not include '${featureKey}'. Please upgrade to access this feature.`,
                );
            }
            next();
        } catch (error) {
            next(error);
        }
    };
}
