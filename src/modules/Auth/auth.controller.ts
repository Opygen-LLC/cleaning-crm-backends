import authService from "./auth.service";
import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { tokenUtils } from "../../lib/utils/token";
import AppError from "../../errorHelper/AppError";
import { AUTH_ERROR_CODES } from "./auth.codes";
import { logAuthLoginStage } from "./authLoginDiagnostics";

const setAuthenticatedCookies = (
    res: Parameters<typeof tokenUtils.setAccessTokenCookie>[0],
    payload: { accessToken: string; refreshToken?: string | null; sessionToken?: string | null },
) => {
    tokenUtils.setAccessTokenCookie(res, payload.accessToken);
    if (payload.refreshToken) tokenUtils.setRefreshTokenCookie(res, payload.refreshToken);
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
    const startedAt = process.hrtime.bigint();
    logAuthLoginStage("AUTH_LOGIN_STARTED");

    const result = await authService.login(req.body, {
        ipAddress: req.ip,
        userAgent: typeof req.get === "function" ? req.get("user-agent") : undefined,
    });

    if (
        !result.user ||
        !result.user.role ||
        !result.sessionToken ||
        !result.accessToken ||
        !result.refreshToken
    ) {
        logAuthLoginStage("AUTH_LOGIN_FAILED", {
            errorCode: AUTH_ERROR_CODES.AUTH_LOGIN_STATE_INCOMPLETE,
        });
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
    logAuthLoginStage("AUTH_COOKIES_CREATED");

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "User Login Successful",
        // The login response intentionally carries no routing/account state.
        // The browser must confirm GET /auth/session before navigation.
        data: { sessionCreated: true },
    });

    logAuthLoginStage("AUTH_LOGIN_COMPLETED", {
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
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

const session = catchAsync(async (req, res) => {
    const sessionToken = req.cookies["better-auth.session_token"];
    const result = await authService.session(req.user, sessionToken);
    // The canonical session snapshot is user-specific security state and must
    // never be cached by a CDN/BFF/shared intermediary.
    res.setHeader("Cache-Control", "private, no-store");
    res.vary("Cookie");
    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Authenticated session confirmed",
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
            // Refresh only rotates credentials. Current identity/routing state
            // remains authoritative exclusively through GET /auth/session.
            data: { refreshed: true },
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
    const result = await authService.verifyEmail(email, otp, {
        ipAddress: req.ip,
        userAgent: typeof req.get === "function" ? req.get("user-agent") : undefined,
    });
    const { accessToken, refreshToken, token } = result;

    setAuthenticatedCookies(res, {
        accessToken,
        refreshToken,
        sessionToken: token,
    });

    sendResponse(res, {
        httpStatusCode: httpStatus.OK,
        success: true,
        message: "Email verified successfully",
        // OTP acceptance is not authentication/routing authority. The client
        // must confirm the newly issued cookies through GET /auth/session.
        data: { verified: true },
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
    const sessionToken =
        req.cookies["better-auth.session_token"] ||
        (req.headers.authorization?.startsWith("Bearer ")
            ? req.headers.authorization.slice(7).trim()
            : undefined);
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
    register, login, me, session, getNewToken, verifyEmail, resendOtp, forgotPassword,
    resetPassword, changePassword, logout,
};
