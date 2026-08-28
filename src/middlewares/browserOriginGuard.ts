import type { NextFunction, Request, Response } from "express";
import { NODE_ENV } from "../config/ENV";
import { getAuthenticatedOrigins } from "../config/authSecurity";
import { AUTH_ERROR_CODES } from "../modules/Auth/auth.codes";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_COOKIE_NAMES = ["accessToken", "refreshToken", "better-auth.session_token"];

/**
 * Cookie authentication re-introduces CSRF risk if state-changing requests are
 * accepted from arbitrary browser origins. CORS alone is not a CSRF control,
 * so any unsafe request carrying our auth cookies must come from an explicitly
 * trusted application/API origin. Server-to-server requests without cookies are
 * unaffected.
 */
export const browserOriginGuard = (req: Request, res: Response, next: NextFunction) => {
    if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return next();

    const hasAuthCookie = AUTH_COOKIE_NAMES.some((name) => Boolean(req.cookies?.[name]));
    if (!hasAuthCookie) return next();

    const origin = req.get("Origin")?.replace(/\/+$/, "");
    if (!origin && NODE_ENV !== "production") return next();

    if (!origin || !getAuthenticatedOrigins().includes(origin)) {
        res.locals.authErrorCode = AUTH_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED;
        return res.status(403).json({
            statusCode: 403,
            success: false,
            code: AUTH_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED,
            message: "Request origin is not allowed",
            errorSources: [],
            fieldErrors: {},
            retryable: false,
            requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : undefined,
        });
    }

    return next();
};
