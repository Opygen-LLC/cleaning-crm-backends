import { Response } from "express";
import { JwtPayload, SignOptions } from "jsonwebtoken";
import { CookieUtils } from "./cookie";
import { jwtUtils } from "./jwt";
import { ACCESS_TOKEN_EXPIRES_IN, ACCESS_TOKEN_SECRET, REFRESH_TOKEN_EXPIRES_IN, REFRESH_TOKEN_SECRET } from "../../config/ENV";

const getAccessToken = (payload: JwtPayload) => {
    const accessToken = jwtUtils.createToken(
        payload,
        ACCESS_TOKEN_SECRET,
        { expiresIn: ACCESS_TOKEN_EXPIRES_IN } as SignOptions,
    );

    return accessToken;
};

const getRefreshToken = (payload: JwtPayload) => {
    const refreshToken = jwtUtils.createToken(
        payload,
        REFRESH_TOKEN_SECRET,
        { expiresIn: REFRESH_TOKEN_EXPIRES_IN } as SignOptions,
    );
    return refreshToken;
};

const setAccessTokenCookie = (res: Response, token: string) => {
    CookieUtils.setCookie(res, "accessToken", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        //1 day
        maxAge: 60 * 60 * 24 * 1000,
    });
};

const setRefreshTokenCookie = (res: Response, token: string) => {
    CookieUtils.setCookie(res, "refreshToken", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        //7d
        maxAge: 60 * 60 * 24 * 1000 * 7,
    });
};

const setBetterAuthSessionCookie = (res: Response, token: string) => {
    CookieUtils.setCookie(res, "better-auth.session_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        //1 day
        maxAge: 60 * 60 * 24 * 1000,
    });
};

export const tokenUtils = {
    getAccessToken,
    getRefreshToken,
    setAccessTokenCookie,
    setRefreshTokenCookie,
    setBetterAuthSessionCookie,
};
