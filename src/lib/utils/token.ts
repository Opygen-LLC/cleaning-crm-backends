import { randomUUID } from "node:crypto";
import { Response } from "express";
import { JwtPayload, SignOptions } from "jsonwebtoken";
import { CookieUtils } from "./cookie";
import { jwtUtils } from "./jwt";
import {
    ACCESS_TOKEN_EXPIRES_IN,
    ACCESS_TOKEN_SECRET,
    NODE_ENV,
    REFRESH_TOKEN_EXPIRES_IN,
    REFRESH_TOKEN_SECRET,
} from "../../config/ENV";

const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const ROLE_HINT_COOKIE_MAX_AGE_MS = SESSION_COOKIE_MAX_AGE_MS;
const SUPPORT_MODE_COOKIE_MAX_AGE_MS = 30 * 60 * 1000;
const SECURE_COOKIE = NODE_ENV === "production";

const getAccessToken = (payload: JwtPayload) =>
    jwtUtils.createToken(payload, ACCESS_TOKEN_SECRET, {
        expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    } as SignOptions);

const getRefreshToken = (payload: JwtPayload, refreshFamilyId?: string) =>
    jwtUtils.createToken(
        {
            ...payload,
            tokenType: "refresh",
            refreshFamilyId: refreshFamilyId || randomUUID(),
            refreshId: randomUUID(),
        },
        REFRESH_TOKEN_SECRET,
        { expiresIn: REFRESH_TOKEN_EXPIRES_IN } as SignOptions,
    );

/**
 * Canonical browser credentials are host-only. When the API is reached through
 * Next.js /backend-api, Set-Cookie is received from the frontend origin, so the
 * browser stores this cookie only for that frontend host.
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
 * Refresh is root-scoped so the cookie works through the /backend-api BFF path.
 * HttpOnly + SameSite=Lax + the server's browserOriginGuard remain the security
 * boundary; JavaScript never receives the token.
 */
const setRefreshTokenCookie = (res: Response, token: string) => {
    CookieUtils.setCookie(res, "refreshToken", token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/",
        maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
};

/** Better Auth session follows the same host-only BFF cookie contract. */
const setBetterAuthSessionCookie = (res: Response, token: string) => {
    CookieUtils.setCookie(res, "better-auth.session_token", token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });
};

/**
 * Non-authoritative route hint for Next.js edge routing. It is HttpOnly so the
 * browser has no JavaScript-readable authentication cookies at all. Backend
 * authorization never trusts this value; role/tenant access is revalidated
 * from the signed access token and current database state.
 */
const setRoleHintCookie = (res: Response, role: string) => {
    CookieUtils.setCookie(res, "user_role", role, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/",
        maxAge: ROLE_HINT_COOKIE_MAX_AGE_MS,
    });
};


const setSupportModeCookie = (res: Response, token: string, maxAgeMs = SUPPORT_MODE_COOKIE_MAX_AGE_MS) => {
    CookieUtils.setCookie(res, "support_mode", token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/",
        maxAge: Math.min(SUPPORT_MODE_COOKIE_MAX_AGE_MS, Math.max(60_000, maxAgeMs)),
    });
};

const clearSupportModeCookie = (res: Response) => {
    CookieUtils.clearCookie(res, "support_mode", {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        path: "/",
    });
};

const clearAuthCookies = (res: Response) => {
    const options = {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax" as const,
        path: "/",
    };

    for (const name of [
        "accessToken",
        "refreshToken",
        "better-auth.session_token",
        "user_role",
        "support_mode",
    ]) {
        CookieUtils.clearCookie(res, name, options);
    }
};

export const tokenUtils = {
    getAccessToken,
    getRefreshToken,
    setAccessTokenCookie,
    setRefreshTokenCookie,
    setBetterAuthSessionCookie,
    setRoleHintCookie,
    setSupportModeCookie,
    clearSupportModeCookie,
    clearAuthCookies,
};
