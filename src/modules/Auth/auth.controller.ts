import authService from "./auth.service";
import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { tokenUtils } from "../../lib/utils/token";
import AppError from "../../errorHelper/AppError";
import { AUTH_ERROR_CODES } from "./auth.codes";

const setAuthenticatedCookies = (
    res: Parameters<typeof tokenUtils.setAccessTokenCookie>[0],
    payload: { accessToken: string; refreshToken: string; sessionToken?: string | null },
) => {
    tokenUtils.setAccessTokenCookie(res, payload.accessToken);
    tokenUtils.setRefreshTokenCookie(res, payload.refreshToken);
    if (payload.sessionToken) tokenUtils.setBetterAuthSessionCookie(res, payload.sessionToken);
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

    if (
        !result.user ||
        !result.user.role ||
        !result.sessionToken ||
        !result.accessToken ||
        !result.refreshToken
    ) {
        throw new AppError(
            httpStatus.INTERNAL_SERVER_ERROR,
            "The authenticated session is incomplete.",
            { code: AUTH_ERROR_CODES.AUTH_LOGIN_STATE_INCOMPLETE, retryable: true },
        );
    }

    setAuthenticatedCookies(res, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        sessionToken: result.sessionToken,
    });

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User Login Successful",
        data: {
            user: result.user,
            needPasswordChange: result.needPasswordChange,
            isOnboardingComplete: result.isOnboardingComplete,
        },
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
        throw new AppError(
            httpStatus.UNAUTHORIZED,
            "Refresh session is missing.",
            { code: AUTH_ERROR_CODES.REFRESH_SESSION_MISSING, retryable: false },
        );
    }

    try {
        const result = await authService.getNewToken(refreshToken, sessionToken);
        setAuthenticatedCookies(res, {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            sessionToken: result.sessionToken,
        });

        sendResponse(res, {
            httpStatusCode: httpStatus.OK,
            success: true,
            message: "Session refreshed successfully",
            data: { refreshed: true, role: result.role },
        });
    } catch (error) {
        // Clear credentials only when refresh state is definitively invalid. A
        // transient 5xx/database outage must not destroy an otherwise valid
        // browser session; the frontend will surface the temporary failure and
        // can retry later. The frontend-owned route hint is cleared by the
        // client only for 400/401/403 refresh failures.
        if (
            error instanceof AppError &&
            (error.statusCode === httpStatus.BAD_REQUEST ||
                error.statusCode === httpStatus.UNAUTHORIZED ||
                error.statusCode === httpStatus.FORBIDDEN)
        ) {
            tokenUtils.clearAuthCookies(res);
        }
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
    if (!sessionToken) {
        throw new AppError(httpStatus.UNAUTHORIZED, "Session is missing", {
            code: AUTH_ERROR_CODES.INVALID_SESSION,
            retryable: false,
        });
    }

    const result = await authService.changePassword(req.body, sessionToken);
    const { accessToken, refreshToken, token, ...clientSafe } = result;
    setAuthenticatedCookies(res, {
        accessToken,
        refreshToken,
        sessionToken: token,
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
