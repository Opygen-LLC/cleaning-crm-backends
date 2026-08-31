import { NextFunction, Request, Response } from "express";
import status from "http-status";
import z from "zod";
import { randomUUID } from "crypto";
import { TErrorResponse, TErrorSources, TFieldErrors } from "../interface/error.interface";
import AppError from "../errorHelper/AppError";
import { handleZodError } from "../errorHelper/handleZodError";
import { Prisma } from "../generated/prisma/client";
import { NODE_ENV, RELEASE_VERSION } from "../config/ENV";
import {
    handlePrismaClientKnownRequestError,
    handlePrismaClientUnknownError,
    handleDatabaseConnectivityError,
    isDatabaseConnectivityError,
    handlePrismaClientValidationError,
    handlerPrismaClientInitializationError,
    handlerPrismaClientRustPanicError,
} from "../errorHelper/handlePrismaError";
import {
    buildFieldErrors,
    getErrorCodeFromStatus,
    isRetryableStatus,
} from "../errorHelper/errorContract";
import logger from "../lib/logger";
import { ErrorMonitor } from "../lib/monitoring/errorMonitor";
import { isAPIError } from "better-auth/api";
import { AUTH_ERROR_CODES } from "../modules/Auth/auth.codes";
import { classifyError, type ErrorKind } from "../errorHelper/errorClassification";

const BETTER_AUTH_STATUS_CODES: Record<string, number> = {
    BAD_REQUEST: status.BAD_REQUEST,
    UNAUTHORIZED: status.UNAUTHORIZED,
    FORBIDDEN: status.FORBIDDEN,
    NOT_FOUND: status.NOT_FOUND,
    CONFLICT: status.CONFLICT,
    TOO_MANY_REQUESTS: status.TOO_MANY_REQUESTS,
    INTERNAL_SERVER_ERROR: status.INTERNAL_SERVER_ERROR,
    SERVICE_UNAVAILABLE: status.SERVICE_UNAVAILABLE,
};

const parseBetterAuthError = (error: unknown) => {
    const record = error as {
        status?: unknown;
        statusCode?: unknown;
        body?: { code?: unknown; message?: unknown };
        code?: unknown;
        message?: unknown;
    };

    const statusValue = record.statusCode ?? record.status;
    const numericStatus =
        typeof statusValue === "string" && /^\d{3}$/.test(statusValue)
            ? Number(statusValue)
            : undefined;
    const statusCode =
        typeof statusValue === "number"
            ? statusValue
            : numericStatus ??
              (typeof statusValue === "string"
                  ? BETTER_AUTH_STATUS_CODES[statusValue.toUpperCase()] ?? status.INTERNAL_SERVER_ERROR
                  : status.INTERNAL_SERVER_ERROR);

    const rawCode =
        typeof record.body?.code === "string"
            ? record.body.code
            : typeof record.code === "string"
              ? record.code
              : AUTH_ERROR_CODES.AUTHENTICATION_SERVICE_ERROR;
    const normalizedCode = rawCode.trim().toUpperCase();

    if (["INVALID_EMAIL_OR_PASSWORD", "INVALID_PASSWORD", "USER_NOT_FOUND"].includes(normalizedCode)) {
        return {
            statusCode: status.UNAUTHORIZED,
            code: AUTH_ERROR_CODES.INVALID_CREDENTIALS,
            message: "Email or password is incorrect.",
            retryable: false,
        };
    }

    if (normalizedCode === "EMAIL_NOT_VERIFIED") {
        return {
            statusCode: status.FORBIDDEN,
            code: AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED,
            message: "Please verify your email before signing in.",
            retryable: false,
        };
    }

    if (["SESSION_EXPIRED", "INVALID_TOKEN", "FAILED_TO_GET_SESSION", "UNAUTHORIZED"].includes(normalizedCode)) {
        return {
            statusCode: status.UNAUTHORIZED,
            code: AUTH_ERROR_CODES.INVALID_SESSION,
            message: "Your session is invalid or has expired.",
            retryable: false,
        };
    }

    if (normalizedCode === "FAILED_TO_CREATE_SESSION") {
        return {
            statusCode: status.INTERNAL_SERVER_ERROR,
            code: AUTH_ERROR_CODES.AUTH_SESSION_NOT_CREATED,
            message: "Your credentials were accepted, but a secure session could not be created.",
            retryable: true,
        };
    }

    if (statusCode >= 500) {
        return {
            statusCode,
            code: AUTH_ERROR_CODES.AUTHENTICATION_SERVICE_ERROR,
            message: "The authentication service could not complete the request. Please try again.",
            retryable: true,
        };
    }

    const safeMessage =
        typeof record.body?.message === "string" && record.body.message.trim()
            ? record.body.message.trim()
            : typeof record.message === "string" && record.message.trim()
              ? record.message.trim()
              : "Authentication request failed.";

    return {
        statusCode,
        code: normalizedCode || getErrorCodeFromStatus(statusCode),
        message: safeMessage,
        retryable: isRetryableStatus(statusCode),
    };
};

const getRequestId = (req: Request, res: Response): string => {
    const existing = res.locals.requestId;
    if (typeof existing === "string" && existing) return existing;

    const header = req.header("x-request-id");
    if (header) return header;

    return randomUUID();
};

export const globalErrorHandler = async (
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    if (res.headersSent) {
        return next(err);
    }

    let errorSources: TErrorSources[] = [];
    let fieldErrors: TFieldErrors = {};
    let statusCode: number = status.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "Something went wrong on our side. Please try again.";
    let retryable = true;
    let kind: ErrorKind | undefined;
    let stack: string | undefined;

    if (isDatabaseConnectivityError(err)) {
        const simplified = handleDatabaseConnectivityError(err);
        statusCode = simplified.statusCode ?? status.SERVICE_UNAVAILABLE;
        code = simplified.code ?? "DATABASE_UNAVAILABLE";
        message = simplified.message;
        errorSources = simplified.errorSources;
        fieldErrors = simplified.fieldErrors ?? {};
        retryable = simplified.retryable ?? true;
        stack = err instanceof Error ? err.stack : undefined;
    } else if (isAPIError(err)) {
        const simplified = parseBetterAuthError(err);
        statusCode = simplified.statusCode;
        code = simplified.code;
        message = simplified.message;
        retryable = simplified.retryable;
        errorSources = [{ path: "", message }];
        stack = err instanceof Error ? err.stack : undefined;
    } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
        const simplified = handlePrismaClientKnownRequestError(err);
        statusCode = simplified.statusCode ?? status.INTERNAL_SERVER_ERROR;
        code = simplified.code ?? getErrorCodeFromStatus(statusCode);
        message = simplified.message;
        errorSources = simplified.errorSources;
        fieldErrors = simplified.fieldErrors ?? buildFieldErrors(errorSources);
        retryable = simplified.retryable ?? isRetryableStatus(statusCode);
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientUnknownRequestError) {
        const simplified = handlePrismaClientUnknownError(err);
        statusCode = simplified.statusCode ?? status.INTERNAL_SERVER_ERROR;
        code = simplified.code ?? "DATABASE_ERROR";
        message = simplified.message;
        errorSources = simplified.errorSources;
        fieldErrors = simplified.fieldErrors ?? {};
        retryable = simplified.retryable ?? true;
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientValidationError) {
        const simplified = handlePrismaClientValidationError(err);
        statusCode = simplified.statusCode ?? status.BAD_REQUEST;
        code = simplified.code ?? "INVALID_DATABASE_REQUEST";
        message = simplified.message;
        errorSources = simplified.errorSources;
        fieldErrors = simplified.fieldErrors ?? {};
        retryable = simplified.retryable ?? false;
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientRustPanicError) {
        const simplified = handlerPrismaClientRustPanicError();
        statusCode = simplified.statusCode ?? status.INTERNAL_SERVER_ERROR;
        code = simplified.code ?? "DATABASE_ENGINE_ERROR";
        message = simplified.message;
        errorSources = simplified.errorSources;
        fieldErrors = simplified.fieldErrors ?? {};
        retryable = simplified.retryable ?? true;
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientInitializationError) {
        const simplified = handlerPrismaClientInitializationError(err);
        statusCode = simplified.statusCode ?? status.SERVICE_UNAVAILABLE;
        code = simplified.code ?? "DATABASE_UNAVAILABLE";
        message = simplified.message;
        errorSources = simplified.errorSources;
        fieldErrors = simplified.fieldErrors ?? {};
        retryable = simplified.retryable ?? true;
        stack = err.stack;
    } else if (err instanceof z.ZodError) {
        const simplified = handleZodError(err);
        statusCode = simplified.statusCode ?? status.BAD_REQUEST;
        code = simplified.code ?? "VALIDATION_ERROR";
        message = simplified.message;
        errorSources = simplified.errorSources;
        fieldErrors = simplified.fieldErrors ?? buildFieldErrors(errorSources);
        retryable = false;
        stack = err.stack;
    } else if (err instanceof AppError) {
        statusCode = err.statusCode;
        code = err.code ?? getErrorCodeFromStatus(statusCode);
        message = err.message;
        retryable = err.retryable ?? isRetryableStatus(statusCode);
        kind = err.kind;
        fieldErrors = err.fieldErrors ?? {};
        errorSources = Object.entries(fieldErrors).map(([path, fieldMessage]) => ({
            path,
            message: fieldMessage,
        }));
        if (errorSources.length === 0) {
            errorSources = [{ path: "", message: err.message }];
        }
        stack = err.stack;
    } else if (err instanceof Error) {
        // Do not expose arbitrary runtime/driver messages in production.
        // They are logged with a request ID below for support/debugging.
        message =
            NODE_ENV === "development"
                ? err.message
                : "Something went wrong on our side. Please try again.";
        errorSources = [{ path: "", message }];
        stack = err.stack;
    }

    const errorKind = kind ?? classifyError(statusCode, code);
    const requestId = getRequestId(req, res);
    res.setHeader("X-Request-Id", requestId);
    if ((req.originalUrl || req.path).startsWith("/api/v1/auth")) {
        res.locals.authErrorCode = code;
    }

    const traceId = typeof res.locals.traceId === "string" ? res.locals.traceId : null;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const monitoredMessage = NODE_ENV === "production" ? message : errorMessage;
    const errorStack = err instanceof Error ? err.stack ?? null : null;
    if (statusCode >= 500) {
        if (NODE_ENV === "production") {
            logger.error("http_error", {
                event: "http_error",
                requestId,
                traceId,
                route: req.path,
                method: req.method,
                statusCode,
                code,
                kind: errorKind,
                releaseSha: RELEASE_VERSION,
                errorMessage: monitoredMessage,
            });
        } else {
            logger.error(
                `${req.method} ${req.path} failed → ${statusCode} ${code}: ${message} · request ${requestId.slice(0, 8)}`,
            );
            if (process.env.LOG_VERBOSE_ERRORS === "true" && errorStack) {
                logger.debug(errorStack);
            }
        }
        void ErrorMonitor.captureBackendError({
            message: monitoredMessage,
            requestId,
            traceId,
            path: req.originalUrl || req.path,
            method: req.method,
            statusCode,
            code,
            kind: errorKind,
            stack: errorStack,
            releaseVersion: RELEASE_VERSION,
        });
    } else if (NODE_ENV === "development" && errorKind === "TENANT_INVARIANT") {
        logger.error(
            `${req.method} ${req.path} → ${statusCode} ${code}: ${message} · request ${requestId.slice(0, 8)}`,
        );
    }

    const errorResponse: TErrorResponse = {
        statusCode,
        success: false,
        code,
        kind: errorKind,
        message,
        errorSources,
        fieldErrors,
        retryable,
        requestId,
        error: NODE_ENV === "development" ? err : undefined,
        stack: NODE_ENV === "development" ? stack : undefined,
    };

    res.status(statusCode).json(errorResponse);
};
