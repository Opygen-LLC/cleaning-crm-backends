import type { NextFunction, Request, Response } from "express";
import status from "http-status";
import AppError from "../errorHelper/AppError";
import { UserRole } from "../generated/prisma/enums";
import { CookieUtils } from "../lib/utils/cookie";
import { getVerifiedAccessToken } from "../lib/utils/verifiedRequestToken";
import { AUTH_ERROR_CODES } from "../modules/Auth/auth.codes";
import { SupportModeService } from "../modules/SuperAdmin/supportMode.service";

/**
 * Lightweight gate used only by GET /auth/session.
 *
 * Unlike the full checkAuth middleware, this does not resolve tenant,
 * subscription, permissions or Redis-backed runtime context. The canonical
 * session service immediately performs one current-state Session -> User query,
 * which is the authority for status, role, onboarding and session expiry.
 */
export const checkAuthSession = async (
    req: Request,
    _res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const cookieToken = CookieUtils.getCookie(req, "accessToken");
        const bearer = req.headers.authorization?.startsWith("Bearer ")
            ? req.headers.authorization.slice("Bearer ".length).trim()
            : undefined;
        const accessToken = cookieToken || bearer;

        if (!accessToken) {
            throw new AppError(status.UNAUTHORIZED, "Authentication is required.", {
                code: AUTH_ERROR_CODES.ACCESS_TOKEN_MISSING,
                retryable: true,
            });
        }

        const verified = getVerifiedAccessToken(req, accessToken);
        if (!verified.success) {
            if (verified.reason === "EXPIRED") {
                throw new AppError(status.UNAUTHORIZED, "The access token has expired.", {
                    code: AUTH_ERROR_CODES.ACCESS_TOKEN_EXPIRED,
                    retryable: true,
                });
            }

            throw new AppError(status.UNAUTHORIZED, "The access token is invalid.", {
                code: AUTH_ERROR_CODES.ACCESS_TOKEN_INVALID,
                retryable: false,
            });
        }

        const userId = typeof verified.data.userId === "string" ? verified.data.userId : "";
        const email = typeof verified.data.email === "string" ? verified.data.email : "";
        const role = verified.data.role as UserRole | undefined;
        if (!userId || !email || !role || !Object.values(UserRole).includes(role)) {
            throw new AppError(status.UNAUTHORIZED, "The access token is invalid.", {
                code: AUTH_ERROR_CODES.ACCESS_TOKEN_INVALID,
                retryable: false,
            });
        }

        if (role === UserRole.SUPER_ADMIN) {
            const supportMode = await SupportModeService.fromRequest(req, userId);
            if (supportMode) {
                req.supportMode = supportMode;
                req.supportActor = { id: userId, email, role };
            }
        }
        req.user = { id: userId, email, role };
        next();
    } catch (error) {
        next(error);
    }
};
