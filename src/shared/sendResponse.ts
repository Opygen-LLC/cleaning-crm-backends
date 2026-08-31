import { Response } from "express";

export interface PaginationMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

export type ResponseMeta = Partial<PaginationMeta> & Record<string, unknown>;

interface IResponseData<T> {
    httpStatusCode: number;
    success: true;
    message: string;
    data?: T;
    meta?: ResponseMeta;
}

/**
 * Canonical success envelope.
 *
 * Keep HTTP-only information (status code) on the transport and return only
 * success/message/data/meta in the payload. Endpoint-specific aggregates must
 * live under `data` or `meta`; top-level `stats` is intentionally unsupported.
 */
export const sendResponse = <T>(
    res: Response,
    responseData: IResponseData<T>,
) => {
    const { httpStatusCode, success, message, data, meta } = responseData;

    const body: Record<string, unknown> = {
        success,
        message,
        data: data ?? null,
    };

    if (meta !== undefined) body.meta = meta;

    res.status(httpStatusCode).json(body);
};
