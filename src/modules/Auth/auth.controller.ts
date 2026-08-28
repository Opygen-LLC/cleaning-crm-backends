import authService from "./auth.service";
import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { tokenUtils } from "../../lib/utils/token";
import AppError from "../../errorHelper/AppError";

const setAuthenticatedCookies = (
    res: Parameters<typeof tokenUtils.setAccessTokenCookie>[0],
    payload: { accessToken: string; refreshToken: string; sessionToken?: string | null; role?: string | null },
) => {
    tokenUtils.setAccessTokenCookie(res, payload.accessToken);
    tokenUtils.setRefreshTokenCookie(res, payload.refreshToken);
    if (payload.sessionToken) tokenUtils.setBetterAuthSessionCookie(res, payload.sessionToken);
    if (payload.role) tokenUtils.setRoleCookie(res, payload.role);
};

const register = catchAsync(async (req, res) => {
    const result = await authService.register(req.body);
    sendResponse(res, {
        httpStatusCode: httpStatus.CREATED,
        success: true,
        message: "Account and website created. Verification email queued.",
        data: result,
    });
});

const login = catchAsync(async (req, res) => {
    const result = await authService.login(req.body);
    if (!result.accessToken || !result.refreshToken) {
        throw new AppError(httpStatus.FORBIDDEN, "Email not verified. Please verify your email.");
    }

    const { accessToken, refreshToken, token, ...clientSafe } = result;
    setAuthenticatedCookies(res, {
        accessToken,
        refreshToken,
        sessionToken: token,
        role: result.user?.role,
    });

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User Login Successful",
        // Never return bearer/session credentials to browser JavaScript.
        data: clientSafe,
    });
});

const me = catchAsync(async (req, res) => {
    const result = await authService.me(req.user);
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User fetched successfully",
        data: result,
    });
});

const getNewToken = catchAsync(async (req, res) => {
    const refreshToken = req.cookies.refreshToken;
    const sessionToken = req.cookies["better-auth.session_token"];
    if (!refreshToken || !sessionToken) {
        tokenUtils.clearAuthCookies(res);
        throw new AppError(httpStatus.UNAUTHORIZED, "Refresh session is missing");
    }

    try {
        const result = await authService.getNewToken(refreshToken, sessionToken);
        setAuthenticatedCookies(res, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            sessionToken: result.sessionToken,
            role: result.role,
        });

        sendResponse(res, {
            httpStatusCode: httpStatus.OK,
            success: true,
            message: "Session refreshed successfully",
            data: { refreshed: true },
        });
    } catch (error) {
        // Expired/revoked refresh state must also clear the shared route hint so
        // the frontend cannot remain in a stale authenticated shell.
        tokenUtils.clearAuthCookies(res);
        throw error;
    }
});

const verifyEmail = catchAsync(async (req, res) => {
    const { email, otp } = req.body;
    const result = await authService.verifyEmail(email, otp);
    const { accessToken, refreshToken, token, ...clientSafe } = result;

    setAuthenticatedCookies(res, {
        accessToken,
        refreshToken,
        sessionToken: token,
        role: result.user?.role,
    });

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Email verified successfully",
        data: clientSafe,
    });
});

const resendOtp = catchAsync(async (req, res) => {
    await authService.resendOtp(req.body.email);
    sendResponse(res, { httpStatusCode: httpStatus.OK, success: true, message: "Verification email queued successfully" });
});

const forgotPassword = catchAsync(async (req, res) => {
    await authService.forgotPassword(req.body.email);
    sendResponse(res, { httpStatusCode: httpStatus.OK, success: true, message: "Password reset OTP sent to email successfully" });
});

const resetPassword = catchAsync(async (req, res) => {
    const { email, otp, newPassword } = req.body;
    await authService.resetPassword(email, otp, newPassword);
    tokenUtils.clearAuthCookies(res);
    sendResponse(res, { httpStatusCode: httpStatus.OK, success: true, message: "Password reset successfully" });
});

const changePassword = catchAsync(async (req, res) => {
    const sessionToken = req.cookies["better-auth.session_token"];
    if (!sessionToken) throw new AppError(httpStatus.UNAUTHORIZED, "Session is missing");

    const result = await authService.changePassword(req.body, sessionToken);
    const { accessToken, refreshToken, token, ...clientSafe } = result;
    setAuthenticatedCookies(res, {
        accessToken,
        refreshToken,
        sessionToken: token,
        role: result.user?.role,
    });

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Password changed successfully",
        data: clientSafe,
    });
});

const logout = catchAsync(async (req, res) => {
    const sessionToken = req.cookies["better-auth.session_token"];
    const result = await authService.logout(sessionToken);
    tokenUtils.clearAuthCookies(res);
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User logged out successfully",
        data: result,
    });
});

export default {
    register, login, me, getNewToken, verifyEmail, resendOtp, forgotPassword,
    resetPassword, changePassword, logout,
};
