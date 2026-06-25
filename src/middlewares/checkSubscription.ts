// src/middlewares/checkSubscription.ts
//
// ─── Subscription + account-status enforcement ───────────────────────────────
//
// Mounted at the parent router level in routes/index.ts BEFORE the sub-routers
// that contain checkAuth.  That means req.user is NOT yet populated when this
// middleware fires — it is set by checkAuth inside each route handler.
//
// FIX (was bug): this middleware now reads the JWT directly from the request
// (same extraction logic as checkAuth) so it can identify the caller without
// depending on req.user.  This is safe because:
//   • We verify the JWT signature, so the userId/role cannot be tampered with.
//   • checkAuth still runs afterwards and performs its own full verification;
//     this middleware is purely additive.
//   • If the token is missing or invalid we skip silently — checkAuth will
//     reject the request with 401 in the next step.
//
// What is enforced (ADMIN role only — STAFF and SUPER_ADMIN are exempt):
//   • user.status  = SUSPENDED or DELETED  → 403 Forbidden
//   • sub.status   = SUSPENDED             → 402 Payment Required
//   • sub.status   = EXPIRED               → 402 Payment Required
//   • sub.status   = PENDING_PAYMENT       → 402 Payment Required
//   • isTrial=true and trialEndsAt < now   → 402 Payment Required
//   • isTrial=false and currentPeriodEnd < now → 402 Payment Required
//
// Super-admin routes are NOT mounted through gatedRoutes so they are never
// affected by this middleware.
// ---------------------------------------------------------------------------

import { NextFunction, Request, Response } from "express";
import status from "http-status";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import AppError from "../errorHelper/AppError";
import { jwtUtils } from "../lib/utils/jwt";
import { ACCESS_TOKEN_SECRET } from "../config/ENV";
import { CookieUtils } from "../lib/utils/cookie";

// ─── Token extraction (mirrors checkAuth) ─────────────────────────────────────
function getAccessToken(req: Request): string | undefined {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice("Bearer ".length).trim();
    }
    return CookieUtils.getCookie(req, "accessToken");
}

// ─── Middleware ───────────────────────────────────────────────────────────────
export const checkSubscription = async (
    req: Request,
    _res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        // ── Identify caller from JWT ──────────────────────────────────────
        // req.user is not set yet (checkAuth runs inside the sub-router).
        // We parse the token here to get userId + role without trusting req.user.
        const accessToken = getAccessToken(req);
        if (!accessToken) {
            // No token → skip; checkAuth will reject with 401.
            return next();
        }

        const verified = jwtUtils.verifyToken(accessToken, ACCESS_TOKEN_SECRET);
        if (!verified.success || !verified.data) {
            // Invalid token → skip; checkAuth will reject with 401.
            return next();
        }

        const { userId, role } = verified.data as {
            userId: string;
            role: string;
        };

        // ── Only enforce for ADMIN role ────────────────────────────────────
        // STAFF routes are also gated, but staff members are tenants of an
        // admin — their access is governed by the admin's subscription.
        // SUPER_ADMIN routes are on a separate router and never hit this.
        if (role !== UserRole.ADMIN) {
            return next();
        }

        // ── Live account-status check ──────────────────────────────────────
        // checkAuth also does this, but doing it here means a suspended admin
        // is blocked before the sub-router even starts processing the request.
        // The duplicate DB read is minimal overhead for an admin-only path.
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { status: true },
        });

        if (user?.status === AccountStatus.SUSPENDED) {
            throw new AppError(
                status.FORBIDDEN,
                "Your account has been suspended. Please contact support.",
            );
        }

        if (user?.status === AccountStatus.DELETED) {
            throw new AppError(status.FORBIDDEN, "This account has been deleted.");
        }

        // ── Subscription status check ──────────────────────────────────────
        const admin = await prisma.adminProfile.findFirst({
            where: { userId },
            select: { id: true },
        });

        if (!admin) {
            // No admin profile yet — let the sub-router handle it.
            return next();
        }

        const sub = await prisma.subscription.findFirst({
            where: { adminId: admin.id },
            select: {
                status: true,
                isTrial: true,
                trialEndsAt: true,
                currentPeriodEnd: true,
            },
            orderBy: { createdAt: "desc" },
        });

        if (!sub) {
            // No subscription on file — new account; let them through.
            return next();
        }

        const now = new Date();

        if (sub.status === "SUSPENDED") {
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your account has been suspended. Please contact support or submit a payment proof.",
            );
        }

        if (sub.status === "EXPIRED") {
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your subscription has expired. Please renew to continue using the platform.",
            );
        }

        if (sub.status === "PENDING_PAYMENT") {
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your payment proof is under review. Your account will be reactivated once approved.",
            );
        }

        // In-band trial expiry — catches the window before the cron runs.
        if (sub.isTrial && sub.trialEndsAt && sub.trialEndsAt < now) {
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your free trial has ended. Please upgrade to continue.",
            );
        }

        // In-band billing period expiry.
        if (!sub.isTrial && sub.currentPeriodEnd && sub.currentPeriodEnd < now) {
            throw new AppError(
                status.PAYMENT_REQUIRED,
                "Your billing period has ended. Please renew your subscription.",
            );
        }

        next();
    } catch (error) {
        next(error);
    }
};
