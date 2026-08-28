import { Response } from "express";
import { JwtPayload, SignOptions } from "jsonwebtoken";
import { CookieUtils } from "./cookie";
import { jwtUtils } from "./jwt";
import {
    ACCESS_TOKEN_EXPIRES_IN,
    ACCESS_TOKEN_SECRET,
    COOKIE_DOMAIN,
    NODE_ENV,
    REFRESH_TOKEN_EXPIRES_IN,
    REFRESH_TOKEN_SECRET,
} from "../../config/ENV";

const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const ROLE_HINT_MAX_AGE_MS = REFRESH_COOKIE_MAX_AGE_MS;
const SECURE_COOKIE = NODE_ENV === "production";

const getAccessToken = (payload: JwtPayload) =>
    jwtUtils.createToken(payload, ACCESS_TOKEN_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    } as SignOptions);

const getRefreshToken = (payload: JwtPayload) =>
    jwtUtils.createToken(payload, REFRESH_TOKEN_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    } as SignOptions);

/**
 * Access credentials stay host-only on api.opygen.com. The frontend never
 * receives this credential, even as an HttpOnly domain cookie.
 */
const setAccessTokenCookie = (res: Response, token: string) => {
    CookieUtils.setCookie(res, "accessToken", token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_COOKIE_MAX_AGE_MS,
    });
};

/**
 * Keep the refresh token host-only on api.opygen.com. The browser sends it
 * only to auth endpoints and frontend JavaScript can never read it.
 */
const setRefreshTokenCookie = (res: Response, token: string) => {
    CookieUtils.setCookie(res, "refreshToken", token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/api/v1/auth",
        maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
};

/** Better Auth session is also API-host-only and HttpOnly. */
const setBetterAuthSessionCookie = (res: Response, token: string) => {
    CookieUtils.setCookie(res, "better-auth.session_token", token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });
};

/** Route-role marker used by Next.js middleware; never exposed to JS. */
const setRoleCookie = (res: Response, role: string) => {
    CookieUtils.setCookie(res, "user_role", role, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/",
        domain: COOKIE_DOMAIN,
        maxAge: ROLE_HINT_MAX_AGE_MS,
    });
};

const clearAuthCookies = (res: Response) => {
    const host = { httpOnly: true, secure: SECURE_COOKIE, sameSite: "lax" as const, path: "/" };
    const sharedRole = { ...host, domain: COOKIE_DOMAIN };

    CookieUtils.clearCookie(res, "accessToken", host);
    CookieUtils.clearCookie(res, "refreshToken", { ...host, path: "/api/v1/auth" });
    CookieUtils.clearCookie(res, "better-auth.session_token", host);
    CookieUtils.clearCookie(res, "user_role", sharedRole);

    // Rollout cleanup for the previous JS-readable/cross-site cookie contract.
    for (const name of ["opygen_access_token", "opygen_token"]) {
        CookieUtils.clearCookie(res, name, { path: "/", domain: COOKIE_DOMAIN });
        CookieUtils.clearCookie(res, name, { path: "/" });
    }

    // Remove older domain-scoped variants of credentials created before Phase 5.
    for (const name of ["accessToken", "refreshToken", "better-auth.session_token"]) {
        CookieUtils.clearCookie(res, name, { path: "/", domain: COOKIE_DOMAIN });
    }
};

export const tokenUtils = {
    getAccessToken,
    getRefreshToken,
    setAccessTokenCookie,
    setRefreshTokenCookie,
    setBetterAuthSessionCookie,
    setRoleCookie,
    clearAuthCookies,
};
