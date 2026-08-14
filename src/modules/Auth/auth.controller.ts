import authService from "./auth.service";
import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { tokenUtils } from "../../lib/utils/token";
import AppError from "../../errorHelper/AppError";
import { CookieUtils } from "../../lib/utils/cookie";
import { COOKIE_DOMAIN } from "../../config/ENV";

const register = catchAsync(async (req, res) => {
    const result = await authService.register(req.body);

    sendResponse(res, {
        httpStatusCode: httpStatus.CREATED,
        success: true,
        message: "User Created Successful",
        data: result,
    });
});

const login = catchAsync(async (req, res) => {
    const result = await authService.login(req.body);

    // A login that cannot issue tokens is an authentication failure, not a
    // successful HTTP 200 response. Returning 403 lets RTK Query surface the
    // message instead of treating the response as success and failing silently
    // while the UI tries to read a missing user/token payload.
    if (!result.accessToken || !result.refreshToken) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            "Email not verified. Please verify your email.",
        );
    }

    const { accessToken, refreshToken, token, ...rest } = result;

    // Set cookies safely
    tokenUtils.setAccessTokenCookie(res, accessToken);
    tokenUtils.setRefreshTokenCookie(res, refreshToken);

    if (token) {
        tokenUtils.setBetterAuthSessionCookie(res, token);
    }

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User Login Successful",
        data: {
            ...rest,
            token,
            accessToken,
            refreshToken,
        },
    });
});

const me = catchAsync(async (req, res) => {
    const user = req.user;
    const result = await authService.me(user);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User fetched successfully",
        data: result,
    });
});

const getNewToken = catchAsync(async (req, res) => {
    // Cross-domain note: the frontend (opygen.com) and API (api.faysaldev.com)
    // are unrelated root domains, so the refreshToken cookie set by this API
    // is never sent back by the browser on requests made from the frontend's
    // domain. The frontend must therefore send the refresh token explicitly
    // in the request body (it stores the value it got back from /auth/login).
    // The cookie is still checked first for same-origin / local-dev setups.
    const refreshToken = req.cookies.refreshToken || req.body?.refreshToken;
    const betterAuthSessionToken =
        req.cookies["better-auth.session_token"] || req.body?.sessionToken;
    if (!refreshToken) {
        throw new AppError(httpStatus.UNAUTHORIZED, "Refresh token is missing");
    }
    const result = await authService.getNewToken(
        refreshToken,
        betterAuthSessionToken,
    );

    const { accessToken, refreshToken: newRefreshToken, sessionToken } = result;

    tokenUtils.setAccessTokenCookie(res, accessToken);
    tokenUtils.setRefreshTokenCookie(res, newRefreshToken);
    if (sessionToken) {
        tokenUtils.setBetterAuthSessionCookie(res, sessionToken);
    }

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "New tokens generated successfully",
        data: {
            accessToken,
            refreshToken: newRefreshToken,
            sessionToken,
        },
    });
});

const verifyEmail = catchAsync(async (req, res) => {
    const { email, otp } = req.body;
    const result = await authService.verifyEmail(email, otp);

    const { accessToken, refreshToken, token, ...rest } = result;

    tokenUtils.setAccessTokenCookie(res, accessToken);
    tokenUtils.setRefreshTokenCookie(res, refreshToken);
    if (token) {
        tokenUtils.setBetterAuthSessionCookie(res, token);
    }

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Email verified successfully",
        data: result,
    });
});

const resendOtp = catchAsync(async (req, res) => {
    const { email } = req.body;
    await authService.resendOtp(email);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "OTP sent to email successfully",
    });
});

const forgotPassword = catchAsync(async (req, res) => {
    const { email } = req.body;
    await authService.forgotPassword(email);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Password reset OTP sent to email successfully",
    });
});

const resetPassword = catchAsync(async (req, res) => {
    const { email, otp, newPassword } = req.body;
    await authService.resetPassword(email, otp, newPassword);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Password reset successfully",
    });
});

const changePassword = catchAsync(async (req, res) => {
    const payload = req.body;
    const betterAuthSessionToken = req.cookies["better-auth.session_token"];
    const result = await authService.changePassword(
        payload,
        betterAuthSessionToken,
    );

    const { accessToken, refreshToken, token } = result;

    tokenUtils.setAccessTokenCookie(res, accessToken);
    tokenUtils.setRefreshTokenCookie(res, refreshToken);
    tokenUtils.setBetterAuthSessionCookie(res, token as string);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Password changed successfully",
        data: result,
    });
});

const logout = catchAsync(async (req, res) => {
    const betterAuthSessionToken = req.cookies["better-auth.session_token"];
    const result = await authService.logout(betterAuthSessionToken);

    // ─── FIX: clearCookie flags must EXACTLY match the Set-Cookie flags ────
    // Browsers only delete a cookie when the name + path + domain + secure +
    // sameSite all match what was used when the cookie was originally set.
    // Missing `path: "/"` or `httpOnly: true` causes clearCookie to silently
    // fail, leaving stale auth cookies in the browser and the user "still
    // logged in" after clicking logout.
    // ─────────────────────────────────────────────────────────────────────────
    const COOKIE_CLEAR_OPTS = {
        httpOnly: true,
        secure: true,
        sameSite: "none" as const,
        path: "/",
        domain: COOKIE_DOMAIN,
    };

    CookieUtils.clearCookie(res, "accessToken", COOKIE_CLEAR_OPTS);
    CookieUtils.clearCookie(res, "refreshToken", COOKIE_CLEAR_OPTS);
    CookieUtils.clearCookie(
        res,
        "better-auth.session_token",
        COOKIE_CLEAR_OPTS,
    );

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User logged out successfully",
        data: result,
    });
});

const authController = {
    register,
    login,
    me,
    getNewToken,
    verifyEmail,
    resendOtp,
    forgotPassword,
    resetPassword,
    changePassword,
    logout,
};

export default authController;
