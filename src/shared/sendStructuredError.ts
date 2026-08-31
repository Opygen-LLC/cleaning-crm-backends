import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import type { TFieldErrors } from "../interface/error.interface";
import { classifyError, type ErrorKind } from "../errorHelper/errorClassification";
import { isRetryableStatus } from "../errorHelper/errorContract";

export interface StructuredErrorOptions {
    statusCode: number;
    code: string;
    message: string;
    fieldErrors?: TFieldErrors;
    retryable?: boolean;
    kind?: ErrorKind;
    requestId?: string;
}

const resolveRequestId = (
    res: Response,
    req?: Request,
    explicit?: string,
): string => {
    if (explicit) return explicit;
    if (typeof res.locals?.requestId === "string" && res.locals.requestId) {
        return res.locals.requestId;
    }
    const header = req?.header?.("x-request-id");
    return header || randomUUID();
};

/**
 * Public error envelope used by the global handler and by middleware that must
 * terminate a request before control reaches a controller.
 *
 * HTTP status is intentionally kept on the transport rather than duplicated in
 * JSON. Internal error sources/stacks remain server-side; clients receive the
 * stable fields required for UI rendering and support correlation.
 */
export const sendStructuredError = (
    res: Response,
    options: StructuredErrorOptions,
    req?: Request,
) => {
    const requestId = resolveRequestId(res, req, options.requestId);
    const kind = options.kind ?? classifyError(options.statusCode, options.code);
    const retryable = options.retryable ?? isRetryableStatus(options.statusCode);

    if (typeof res.setHeader === "function") {
        res.setHeader("X-Request-Id", requestId);
    }

    return res.status(options.statusCode).json({
        success: false,
        code: options.code,
        kind,
        message: options.message,
        fieldErrors: options.fieldErrors ?? {},
        retryable,
        requestId,
    });
};
