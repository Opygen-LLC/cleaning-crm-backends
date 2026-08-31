import status from "http-status";
import { TErrorResponse, TErrorSources } from "../interface/error.interface";
import { Prisma } from "../generated/prisma/client";
import { buildFieldErrors, getErrorCodeFromStatus, isRetryableStatus } from "./errorContract";

const DATABASE_CONNECTIVITY_CODES = new Set([
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "08007",
    "08P01",
    "57P01",
    "57P02",
    "57P03",
    "53300",
]);

const DATABASE_CONNECTIVITY_MESSAGE_PATTERNS = [
    /can't reach database server/i,
    /connection terminated unexpectedly/i,
    /connection timeout/i,
    /connect etimedout/i,
    /failed to connect/i,
    /server closed the connection unexpectedly/i,
];

const collectErrorSignals = (error: unknown, depth = 0, seen = new Set<unknown>()): string[] => {
    if (depth > 5 || error == null || seen.has(error)) return [];
    seen.add(error);

    if (typeof error === "string") return [error];
    if (typeof error !== "object") return [];

    const record = error as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
        error?: unknown;
        originalError?: unknown;
        errors?: unknown;
    };

    const signals: string[] = [];
    if (typeof record.code === "string") signals.push(record.code);
    if (typeof record.message === "string") signals.push(record.message);
    for (const nested of [record.cause, record.error, record.originalError]) {
        signals.push(...collectErrorSignals(nested, depth + 1, seen));
    }
    if (Array.isArray(record.errors)) {
        for (const nested of record.errors) signals.push(...collectErrorSignals(nested, depth + 1, seen));
    }
    return signals;
};

export const isDatabaseConnectivityError = (error: unknown): boolean => {
    if (error instanceof Prisma.PrismaClientInitializationError) return true;

    const signals = collectErrorSignals(error);
    return signals.some((signal) => {
        const normalized = signal.trim().toUpperCase();
        if (DATABASE_CONNECTIVITY_CODES.has(normalized)) return true;
        return DATABASE_CONNECTIVITY_MESSAGE_PATTERNS.some((pattern) => pattern.test(signal));
    });
};

export const handleDatabaseConnectivityError = (_error: unknown): TErrorResponse => ({
    success: false,
    statusCode: status.SERVICE_UNAVAILABLE,
    code: "DATABASE_UNAVAILABLE",
    message: "The database is temporarily unavailable. Please try again shortly.",
    errorSources: [],
    fieldErrors: {},
    retryable: true,
});

/**
 * Prisma known-request errors cover both expected data conflicts and genuine
 * database/runtime faults. Never collapse the whole P2xxx family into a 400:
 * schema drift (P2021/P2022) and raw-query failures (P2010) are server errors.
 */
export const getStatusCodeFromPrismaError = (errorCode: string): number => {
    if (errorCode === "P2002" || errorCode === "P2003") return status.CONFLICT;

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

    // P2010 = raw query failed; P2021/P2022 = table/column missing. These are
    // deployment/schema defects and must be observable as server failures.
    if (["P2010", "P2021", "P2022"].includes(errorCode)) {
        return status.INTERNAL_SERVER_ERROR;
    }

    // Unknown P2xxx errors are safer as server faults than as fake validation
    // failures. Add explicit mappings above when a code is proven user-caused.
    if (errorCode.startsWith("P2")) return status.INTERNAL_SERVER_ERROR;

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

    if (errorCode === "P2003") {
        return "This change conflicts with related data. Refresh and try again.";
    }

    if (["P2025", "P2001", "P2015", "P2018"].includes(errorCode)) {
        return "The requested record could not be found.";
    }

    if (errorCode === "P2024" || errorCode === "P1008") {
        return "The database is taking too long to respond. Please try again.";
    }

    if (["P2021", "P2022"].includes(errorCode)) {
        return "The database schema is not ready for this release. Please try again shortly.";
    }

    if (errorCode === "P2010") {
        return "A database query failed. Please try again shortly.";
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

    return "A database error prevented the request from completing.";
};

const codeForKnownError = (errorCode: string, statusCode: number): string => {
    if (errorCode === "P2002") return "DUPLICATE_RESOURCE";
    if (errorCode === "P2003") return "RELATION_CONFLICT";
    if (["P2021", "P2022"].includes(errorCode)) return "DATABASE_SCHEMA_MISMATCH";
    if (errorCode === "P2010") return "DATABASE_QUERY_ERROR";
    if (errorCode === "P2024" || errorCode === "P1008") return "DATABASE_TIMEOUT";
    if (errorCode.startsWith("P2") && statusCode >= 500) return "DATABASE_ERROR";
    return getErrorCodeFromStatus(statusCode);
};

const safeMetaValue = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 240) return undefined;
    // Log only identifier-like Prisma metadata; never SQL, values or secrets.
    return /^[A-Za-z0-9_."-]+$/.test(trimmed) ? trimmed : undefined;
};

export interface PrismaErrorLogContext {
    prismaCode: string;
    prismaModel?: string;
    prismaTable?: string;
    prismaColumn?: string;
}

export const getPrismaErrorLogContext = (
    error: Prisma.PrismaClientKnownRequestError,
): PrismaErrorLogContext => {
    const meta = error.meta ?? {};
    return {
        prismaCode: error.code,
        prismaModel: safeMetaValue(meta.modelName ?? meta.model),
        prismaTable: safeMetaValue(meta.table),
        prismaColumn: safeMetaValue(meta.column),
    };
};

export const handlePrismaClientKnownRequestError = (
    error: Prisma.PrismaClientKnownRequestError,
): TErrorResponse => {
    const statusCode = getStatusCodeFromPrismaError(error.code);
    const message = consumerMessageForKnownError(error.code);
    const isSystemFailure = statusCode >= 500;
    const targetFields = isSystemFailure ? [] : extractTargetFields(error.meta);

    const errorSources: TErrorSources[] = targetFields.length > 0
        ? targetFields.map((field) => ({ path: field, message }))
        : [];

    return {
        success: false,
        statusCode,
        code: codeForKnownError(error.code, statusCode),
        message,
        errorSources,
        fieldErrors: isSystemFailure ? {} : buildFieldErrors(errorSources),
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
