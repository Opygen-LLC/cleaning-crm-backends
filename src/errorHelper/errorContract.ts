import status from "http-status";
import { TErrorSources, TFieldErrors } from "../interface/error.interface";

export const getErrorCodeFromStatus = (statusCode: number): string => {
    switch (statusCode) {
        case status.BAD_REQUEST:
            return "BAD_REQUEST";
        case status.UNAUTHORIZED:
            return "UNAUTHENTICATED";
        case status.PAYMENT_REQUIRED:
            return "PAYMENT_REQUIRED";
        case status.FORBIDDEN:
            return "FORBIDDEN";
        case status.NOT_FOUND:
            return "NOT_FOUND";
        case status.CONFLICT:
            return "CONFLICT";
        case status.REQUEST_TIMEOUT:
            return "REQUEST_TIMEOUT";
        case status.REQUEST_ENTITY_TOO_LARGE:
            return "PAYLOAD_TOO_LARGE";
        case status.UNPROCESSABLE_ENTITY:
            return "VALIDATION_ERROR";
        case status.TOO_MANY_REQUESTS:
            return "RATE_LIMITED";
        case status.BAD_GATEWAY:
            return "BAD_GATEWAY";
        case status.SERVICE_UNAVAILABLE:
            return "SERVICE_UNAVAILABLE";
        case status.GATEWAY_TIMEOUT:
            return "GATEWAY_TIMEOUT";
        default:
            return statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED";
    }
};

export const isRetryableStatus = (statusCode: number): boolean =>
    (
        [
            status.REQUEST_TIMEOUT,
            status.TOO_MANY_REQUESTS,
            status.BAD_GATEWAY,
            status.SERVICE_UNAVAILABLE,
            status.GATEWAY_TIMEOUT,
        ] as number[]
    ).includes(statusCode) || statusCode >= 500;

const normaliseFieldPath = (path: string): string =>
    path
        .replace(/\s*=>\s*/g, ".")
        .replace(/^body\./, "")
        .replace(/^query\./, "")
        .replace(/^params\./, "")
        .trim();

export const buildFieldErrors = (
    errorSources: TErrorSources[],
): TFieldErrors => {
    const fieldErrors: TFieldErrors = {};

    for (const source of errorSources) {
        const path = normaliseFieldPath(source.path);
        if (!path) continue;

        // Internal/database identifiers are useful in logs, not as form field
        // names in the consumer UI.
        if (/^P\d{4}$/i.test(path)) continue;
        if (
            [
                "cause",
                "database",
                "unknown prisma error",
                "initialization error",
                "rust engine crashed",
            ].includes(path.toLowerCase())
        ) {
            continue;
        }

        if (!fieldErrors[path]) {
            fieldErrors[path] = source.message;
        }
    }

    return fieldErrors;
};
