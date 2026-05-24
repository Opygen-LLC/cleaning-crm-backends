import { Response } from "express";

interface IResponseData<T> {
    httpStatusCode: number;
    success: boolean;
    message: string;
    data?: T;
    meta?: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
    stats?: Record<string, unknown>;
}

export const sendResponse = <T>(
    res: Response,
    responseData: IResponseData<T>,
) => {
    const { httpStatusCode, success, message, data, meta, stats } = responseData;

    res.status(httpStatusCode).json({
        success,
        message,
        data,
        meta,
        ...(stats !== undefined ? { stats } : {}),
    });
};
