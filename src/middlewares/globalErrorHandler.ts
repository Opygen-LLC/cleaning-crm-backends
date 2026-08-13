import { NextFunction, Request, Response } from "express";
import status from "http-status";
import z from "zod";
import { randomUUID } from "crypto";
import { TErrorResponse, TErrorSources, TFieldErrors } from "../interface/error.interface";
import AppError from "../errorHelper/AppError";
import { handleZodError } from "../errorHelper/handleZodError";
import { Prisma } from "../generated/prisma/client";
import { NODE_ENV } from "../config/ENV";
import {
    handlePrismaClientKnownRequestError,
    handlePrismaClientUnknownError,
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
    let stack: string | undefined;

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
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

    const requestId = getRequestId(req, res);
    res.setHeader("X-Request-Id", requestId);

    const logMessage = `[${requestId}] ${req.method} ${req.path} -> ${statusCode} ${code}: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
    }`;
    if (statusCode >= 500) {
        logger.error(logMessage);
    } else if (NODE_ENV === "development") {
        logger.warn(logMessage);
    }

    const errorResponse: TErrorResponse = {
        statusCode,
        success: false,
        code,
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
