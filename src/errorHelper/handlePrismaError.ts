import status from "http-status";
import { TErrorResponse, TErrorSources } from "../interface/error.interface";
import { Prisma } from "../generated/prisma/client";
import { buildFieldErrors, getErrorCodeFromStatus, isRetryableStatus } from "./errorContract";

/**
 * Database/authentication/connectivity failures are server infrastructure
 * problems. They must never be returned as HTTP 401, otherwise the frontend
 * mistakes them for an expired user token and starts an unnecessary refresh
 * cycle.
 */
const getStatusCodeFromPrismaError = (errorCode: string): number => {
    if (errorCode === "P2002") return status.CONFLICT;

    if (["P2025", "P2001", "P2015", "P2018"].includes(errorCode)) {
        return status.NOT_FOUND;
    }

    if (errorCode === "P5011") return status.TOO_MANY_REQUESTS;
    if (errorCode === "P6009") return status.REQUEST_ENTITY_TOO_LARGE;

    if (["P1008", "P2024", "P6004"].includes(errorCode)) {
        return status.GATEWAY_TIMEOUT;
    }

    if (
        errorCode.startsWith("P1") ||
        ["P6002", "P6003", "P6008", "P6010", "P2037"].includes(errorCode)
    ) {
        return status.SERVICE_UNAVAILABLE;
    }

    if (errorCode.startsWith("P2")) return status.BAD_REQUEST;

    return status.INTERNAL_SERVER_ERROR;
};

const extractTargetFields = (meta?: Record<string, unknown>): string[] => {
    const target = meta?.target;
    if (Array.isArray(target)) {
        return target.filter((item): item is string => typeof item === "string");
    }
    if (typeof target === "string") {
        return target
            .replace(/[()\[\]`'"]/g, "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
};

const consumerMessageForKnownError = (errorCode: string): string => {
    if (errorCode === "P2002") {
        return "A record with the same details already exists.";
    }

    if (["P2025", "P2001", "P2015", "P2018"].includes(errorCode)) {
        return "The requested record could not be found.";
    }

    if (errorCode === "P2003") {
        return "This request references data that does not exist or cannot be changed.";
    }

    if (errorCode === "P2024" || errorCode === "P1008") {
        return "The service is taking too long to respond. Please try again.";
    }

    if (errorCode === "P5011") {
        return "Too many requests were made. Please try again shortly.";
    }

    if (errorCode === "P6009") {
        return "The requested response is too large. Please narrow the request and try again.";
    }

    if (
        errorCode.startsWith("P1") ||
        ["P6002", "P6003", "P6004", "P6008", "P6010", "P2037"].includes(errorCode)
    ) {
        return "The service is temporarily unavailable. Please try again shortly.";
    }

    if (errorCode.startsWith("P2")) {
        return "The request could not be completed with the supplied data.";
    }

    return "A database error prevented the request from completing.";
};

export const handlePrismaClientKnownRequestError = (
    error: Prisma.PrismaClientKnownRequestError,
): TErrorResponse => {
    const statusCode = getStatusCodeFromPrismaError(error.code);
    const message = consumerMessageForKnownError(error.code);
    const targetFields = extractTargetFields(error.meta);

    const errorSources: TErrorSources[] =
        targetFields.length > 0
            ? targetFields.map((field) => ({ path: field, message }))
            : [{ path: error.code, message }];

    return {
        success: false,
        statusCode,
        code: error.code === "P2002" ? "DUPLICATE_RESOURCE" : getErrorCodeFromStatus(statusCode),
        message,
        errorSources,
        fieldErrors: buildFieldErrors(errorSources),
        retryable: isRetryableStatus(statusCode),
    };
};

export const handlePrismaClientUnknownError = (
    _error: Prisma.PrismaClientUnknownRequestError,
): TErrorResponse => ({
    success: false,
    statusCode: status.INTERNAL_SERVER_ERROR,
    code: "DATABASE_ERROR",
    message: "A database error prevented the request from completing.",
    errorSources: [],
    retryable: true,
});

export const handlePrismaClientValidationError = (
    _error: Prisma.PrismaClientValidationError,
): TErrorResponse => ({
    success: false,
    statusCode: status.BAD_REQUEST,
    code: "INVALID_DATABASE_REQUEST",
    message: "The request could not be completed with the supplied data.",
    errorSources: [],
    retryable: false,
});

export const handlerPrismaClientInitializationError = (
    error: Prisma.PrismaClientInitializationError,
): TErrorResponse => {
    const statusCode = error.errorCode
        ? getStatusCodeFromPrismaError(error.errorCode)
        : status.SERVICE_UNAVAILABLE;

    return {
        success: false,
        statusCode,
        code: "DATABASE_UNAVAILABLE",
        message: "The service is temporarily unavailable. Please try again shortly.",
        errorSources: [],
        retryable: true,
    };
};

export const handlerPrismaClientRustPanicError = (): TErrorResponse => ({
    success: false,
    statusCode: status.INTERNAL_SERVER_ERROR,
    code: "DATABASE_ENGINE_ERROR",
    message: "The service encountered a temporary database problem. Please try again.",
    errorSources: [],
    retryable: true,
});
