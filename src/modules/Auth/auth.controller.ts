import authService from "./auth.service";
import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { tokenUtils } from "../../lib/utils/token";
import AppError from "../../errorHelper/AppError";
import { CookieUtils } from "../../lib/utils/cookie";

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

    // If user is not verified (no tokens returned)
    if (!result.accessToken || !result.refreshToken) {
        return sendResponse(res, {
            httpStatusCode: httpStatus.OK,
            success: false,
            message: "Email not verified. Please verify your email.",
            data: result,
        });
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
    const refreshToken = req.cookies.refreshToken;
    const betterAuthSessionToken = req.cookies["better-auth.session_token"];
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
    tokenUtils.setBetterAuthSessionCookie(res, sessionToken);

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

const changePassword = catchAsync(
    async (req, res) => {
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
    },
);

const logout = catchAsync(async (req, res) => {
    const betterAuthSessionToken = req.cookies["better-auth.session_token"];
    const result = await authService.logout(betterAuthSessionToken);
    CookieUtils.clearCookie(res, "accessToken", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
    });
    CookieUtils.clearCookie(res, "refreshToken", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
    });
    CookieUtils.clearCookie(res, "better-auth.session_token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
    });

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
