import { NextFunction, Request, Response } from "express";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { CookieUtils } from "../lib/utils/cookie";
import { prisma } from "../lib/prisma/prisma";
import { getVerifiedAccessToken } from "../lib/utils/verifiedRequestToken";
import redis from "../config/redis";

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

            // ── Account status check (Redis cached with 60s TTL) ────────────
            let userStatus: string | null = await redis
                .get(`auth:status:${tokenData.userId}`)
                .catch(() => null);

            if (!userStatus) {
                const user = await prisma.user.findUnique({
                    where: { id: tokenData.userId as string },
                    select: { id: true, status: true },
                });

                if (!user) {
                    throw new AppError(
                        status.UNAUTHORIZED,
                        "Account not found. Please log in again.",
                    );
                }

                userStatus = user.status;
                await redis
                    .setex(`auth:status:${tokenData.userId}`, 60, user.status)
                    .catch(() => {});
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


            // ── Optional session bookkeeping ────────────────────────────────
            // If the better-auth session cookie is present (same-origin / local
            // dev), verify it's still valid. We do NOT fail if it's absent —
            // only if it's present but revoked.
            const sessionToken = CookieUtils.getCookie(
                req,
                "better-auth.session_token",
            );
            if (sessionToken) {
                const sessionExists = await prisma.session.findFirst({
                    where: {
                        token: sessionToken,
                        expiresAt: { gt: new Date() },
                    },
                });
                if (!sessionExists) {
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
            };

            next();
        } catch (error) {
            next(error);
        }
    };
