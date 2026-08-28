import { AUTH_ERROR_CODES } from "../modules/Auth/auth.codes";
import { rateLimit } from "express-rate-limit";

const jsonHandler = (message: string) => ({
    statusCode: 429,
    success: false,
    code: AUTH_ERROR_CODES.RATE_LIMITED,
    message,
    errorSources: [],
    fieldErrors: {},
    retryable: true,
});

const baseOptions = {
    windowMs: 15 * 60 * 1000,
    standardHeaders: "draft-8" as const,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
};

export const registrationRateLimit = rateLimit({
    ...baseOptions,
    limit: 5,
    message: jsonHandler("Too many account creation attempts. Please wait 15 minutes and try again."),
});

export const loginRateLimit = rateLimit({
    ...baseOptions,
    limit: 10,
    message: jsonHandler("Too many sign-in attempts. Please wait 15 minutes and try again."),
});

export const otpRateLimit = rateLimit({
    ...baseOptions,
    limit: 5,
    message: jsonHandler("Too many verification attempts. Please wait 15 minutes and try again."),
});

export const passwordResetRateLimit = rateLimit({
    ...baseOptions,
    limit: 5,
    message: jsonHandler("Too many password reset attempts. Please wait 15 minutes and try again."),
});
