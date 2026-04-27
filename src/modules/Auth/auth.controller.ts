import authService from "./auth.service";
import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { tokenUtils } from "../../lib/utils/token";
import AppError from "../../errorHelper/AppError";
import { CookieUtils } from "../../lib/utils/cookie";

const register = catchAsync(async (req, res) => {
    const result = await authService.register(req.body);

    const { accessToken, refreshToken, token, ...rest } = result;

    tokenUtils.setAccessTokenCookie(res, accessToken);
    tokenUtils.setRefreshTokenCookie(res, refreshToken);
    tokenUtils.setBetterAuthSessionCookie(res, token as string);

    sendResponse(res, {
        httpStatusCode: httpStatus.CREATED,
        success: true,
        message: "User Created Successful",
        data: result,
    });
});

const login = catchAsync(async (req, res) => {
    const result = await authService.login(req.body);

    const { accessToken, refreshToken, token, ...rest } = result;

    tokenUtils.setAccessTokenCookie(res, accessToken);
    tokenUtils.setRefreshTokenCookie(res, refreshToken);
    tokenUtils.setBetterAuthSessionCookie(res, token);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User Login Successful",
        data: result,
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

const getNewToken = catchAsync(async (req, res, next) => {
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

const verifyEmail = catchAsync(async (req, res, next) => {
    const { email, otp } = req.body;
    await authService.verifyEmail(email, otp);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Email verified successfully",
    });
});

const forgotPassword = catchAsync(async (req, res, next) => {
    const { email } = req.body;
    await authService.forgotPassword(email);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Password reset OTP sent to email successfully",
    });
});

const resetPassword = catchAsync(async (req, res, next) => {
    const { email, otp, newPassword } = req.body;
    await authService.resetPassword(email, otp, newPassword);

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Password reset successfully",
    });
});

const logout = catchAsync(async (req, res, next) => {
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
    forgotPassword,
    resetPassword,
    logout,
};

export default authController;
