import { NextFunction, Request, Response } from "express";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { CookieUtils } from "../lib/utils/cookie";
import { getVerifiedAccessToken } from "../lib/utils/verifiedRequestToken";
import {
    getRuntimeSessionValidity,
    getRuntimeTenantId,
    getRuntimeUserStatus,
} from "../lib/cache/authRuntimeCache";
import { privateResponseCache } from "./privateResponseCache";

// ─── Cross-domain auth note ──────────────────────────────────────────────────

// The frontend (opygen.com) and API (api.faysaldev.com) are unrelated root
// domains, so cookies cannot bridge them. Access tokens are accepted from both
// Authorization: Bearer <token> headers (production) and the accessToken cookie
// (same-origin / local dev). See original file for full explanation.

const getAccessTokenFromRequest = (req: Request): string | undefined => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice("Bearer ".length).trim();
    }
    return CookieUtils.getCookie(req, "accessToken");
};

export const checkAuth =
    (...authRoles: UserRole[]) =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const accessToken = getAccessTokenFromRequest(req);

            if (!accessToken) {
                throw new AppError(
                    status.UNAUTHORIZED,
                    "Unauthorized access! No access token provided.",
                );
            }

            // ── JWT verification ────────────────────────────────────────────
            // PERF FIX (Phase 1.4): reuses the cached verification result if
            // checkSubscription (which runs earlier, at router level, on
            // gated routes) already verified this exact token for this
            // request — avoids a second jwt.verify() call per request.
            const verifiedToken = getVerifiedAccessToken(req, accessToken);
            if (!verifiedToken.success) {
                throw new AppError(status.UNAUTHORIZED, "Invalid access token.");
            }

            const tokenData = verifiedToken.data;

            // ── Role check (from JWT) ───────────────────────────────────────
            if (
                authRoles.length > 0 &&
                !authRoles.includes(tokenData.role as UserRole)
            ) {
                throw new AppError(status.FORBIDDEN, "Forbidden access.");
            }

            // checkSubscription runs before route-level auth on gated routes.
            // Reuse its request-local result; otherwise use the shared Redis
            // cache and fall back to Postgres on a miss.
            const userStatus =
                req.authRuntime?.userStatus ??
                (await getRuntimeUserStatus(tokenData.userId as string));

            if (!userStatus) {
                throw new AppError(
                    status.UNAUTHORIZED,
                    "Account not found. Please log in again.",
                );
            }

            if (userStatus === AccountStatus.SUSPENDED) {
                throw new AppError(
                    status.FORBIDDEN,
                    "Your account has been suspended. Please contact support.",
                );
            }

            if (userStatus === AccountStatus.DELETED) {
                throw new AppError(
                    status.FORBIDDEN,
                    "This account has been deleted.",
                );
            }

            // Resolve both ADMIN and STAFF to the owning tenant. Besides
            // removing repeated service queries, this gives the response
            // cache a tenant namespace that mutations can invalidate safely.
            const role = tokenData.role as UserRole;
            const adminId =
                req.authRuntime?.adminId !== undefined
                    ? req.authRuntime.adminId
                    : await getRuntimeTenantId(tokenData.userId as string, role);

            // ── Optional session bookkeeping ────────────────────────────────
            // If the better-auth session cookie is present (same-origin / local
            // dev), verify it's still valid. We do NOT fail if it's absent —
            // only if it's present but revoked.
            const sessionToken = CookieUtils.getCookie(
                req,
                "better-auth.session_token",
            );
            if (sessionToken) {
                const isSessionValid =
                    await getRuntimeSessionValidity(sessionToken);

                if (!isSessionValid) {
                    throw new AppError(
                        status.UNAUTHORIZED,
                        "Session has been revoked. Please log in again.",
                    );
                }
            }

            req.user = {
                id: tokenData.userId as string,
                role: tokenData.role as UserRole,
                email: tokenData.email as string,
                adminId,
            };

            await privateResponseCache(req, res, next);
        } catch (error) {
            next(error);
        }
    };
