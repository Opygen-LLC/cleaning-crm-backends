import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { AUTH_ERROR_CODES } from "../modules/Auth/auth.codes";
import { sendStructuredError } from "../shared/sendStructuredError";

const rateLimitHandler = (message: string) => (req: Request, res: Response) =>
    sendStructuredError(res, {
        statusCode: 429,
        code: AUTH_ERROR_CODES.RATE_LIMITED,
        message,
        fieldErrors: {},
        retryable: true,
    }, req);

const baseOptions = {
    windowMs: 15 * 60 * 1000,
    standardHeaders: "draft-8" as const,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
};

export const registrationRateLimit = rateLimit({
    ...baseOptions,
    limit: 5,
    handler: rateLimitHandler("Too many account creation attempts. Please wait 15 minutes and try again."),
});

export const loginRateLimit = rateLimit({
    ...baseOptions,
    limit: 10,
    handler: rateLimitHandler("Too many sign-in attempts. Please wait 15 minutes and try again."),
});

export const otpRateLimit = rateLimit({
    ...baseOptions,
    limit: 5,
    handler: rateLimitHandler("Too many verification attempts. Please wait 15 minutes and try again."),
});

export const passwordResetRateLimit = rateLimit({
    ...baseOptions,
    limit: 5,
    handler: rateLimitHandler("Too many password reset attempts. Please wait 15 minutes and try again."),
});
