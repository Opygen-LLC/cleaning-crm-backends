import { NextFunction, Request, Response } from "express";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import { UserRole } from "../generated/prisma/enums";
import { CookieUtils } from "../lib/utils/cookie";
import { prisma } from "../lib/prisma/prisma";
import { jwtUtils } from "../lib/utils/jwt";
import { ACCESS_TOKEN_SECRET } from "../config/ENV";

// ─── Cross-domain auth note ─────────────────────────────────────────────────
// The frontend (opygen.com) and API (api.faysaldev.com) are unrelated root
// domains — not subdomains of a shared parent — so a cookie's `Domain`
// attribute can never bridge them (browsers only allow a cookie's domain to
// be the issuing host or a parent of it). That means we cannot rely on
// Set-Cookie / automatic cookie attachment for the tokens the frontend needs
// to read across that boundary.
//
// Instead, the access token is also accepted from a standard
// `Authorization: Bearer <token>` header, which the frontend attaches
// explicitly using the token it received in the login response body. The
// cookie is still checked first for same-origin / local-dev setups where it
// works fine, but the header is the path that actually works in production
// here.
//
// The better-auth session cookie has the same cross-domain problem and, in
// this setup, has no independent value beyond what's already encoded in the
// access token JWT (userId, role, email — see auth.service.ts tokenPayload).
// We therefore treat it as optional: present it for the IP/session bookkeeping
// when available (same-origin requests), but do not hard-require it to
// authorize a request.
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

            // JWT verification — this is the actual source of truth for
            // identity/role and works regardless of cookie domain issues.
            const verifiedToken = jwtUtils.verifyToken(
                accessToken,
                ACCESS_TOKEN_SECRET,
            );
            if (!verifiedToken.success) {
                throw new AppError(
                    status.UNAUTHORIZED,
                    "Invalid access token.",
                );
            }

            const tokenData = verifiedToken.data!;

            // Role check (from JWT)
            if (
                authRoles.length > 0 &&
                !authRoles.includes(tokenData.role as UserRole)
            ) {
                throw new AppError(status.FORBIDDEN, "Forbidden access.");
            }

            // Optional same-origin session bookkeeping: if the better-auth
            // session cookie did make it through (same-origin / local dev),
            // verify it's still valid and not revoked. We do NOT fail the
            // request if it's missing — only if it's present but invalid,
            // since a stale/forged session token presented alongside a
            // valid JWT is worth rejecting.
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
