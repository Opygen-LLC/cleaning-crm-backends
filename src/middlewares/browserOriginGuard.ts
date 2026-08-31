import type { NextFunction, Request, Response } from "express";
import { NODE_ENV } from "../config/ENV";
import { getAuthenticatedOrigins } from "../config/authSecurity";
import { AUTH_ERROR_CODES } from "../modules/Auth/auth.codes";
import { sendStructuredError } from "../shared/sendStructuredError";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_COOKIE_NAMES = ["accessToken", "refreshToken", "better-auth.session_token"];
export const CSRF_PROTECTION_HEADER = "x-csrf-protection";
export const CSRF_PROTECTION_VALUE = "1";

const deny = (res: Response, code: string, message: string) => {
    res.locals.authErrorCode = code;
    return sendStructuredError(res, {
        statusCode: 403,
        code,
        message,
        fieldErrors: {},
        retryable: false,
    });
};

/**
 * CSRF boundary for cookie-authenticated mutations.
 *
 * We intentionally use three independent browser signals:
 *  1. trusted Origin,
 *  2. Fetch Metadata when the browser supplies it,
 *  3. a required non-simple custom header added by our first-party clients.
 *
 * A cross-site HTML form cannot set the custom header, and cross-origin JS
 * cannot send it unless CORS explicitly authorizes that origin. SameSite=Lax
 * remains defense-in-depth rather than the only CSRF control.
 */
export const browserOriginGuard = (req: Request, res: Response, next: NextFunction) => {
    if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return next();

    const hasAuthCookie = AUTH_COOKIE_NAMES.some((name) => Boolean(req.cookies?.[name]));
    if (!hasAuthCookie) return next();

    const origin = req.get("Origin")?.replace(/\/+$/, "");
    if (!origin && NODE_ENV !== "production") return next();

    if (!origin || !getAuthenticatedOrigins().includes(origin)) {
        return deny(res, AUTH_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED, "Request origin is not allowed");
    }

    const fetchSite = req.get("Sec-Fetch-Site")?.trim().toLowerCase();
    if (fetchSite === "cross-site") {
        return deny(res, AUTH_ERROR_CODES.CSRF_VALIDATION_FAILED, "Cross-site authenticated mutation blocked");
    }

    if (req.get(CSRF_PROTECTION_HEADER) !== CSRF_PROTECTION_VALUE) {
        return deny(res, AUTH_ERROR_CODES.CSRF_VALIDATION_FAILED, "CSRF protection header is missing or invalid");
    }

    return next();
};
