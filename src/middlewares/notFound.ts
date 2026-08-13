import { Request, Response } from "express";
import status from "http-status";
import { randomUUID } from "crypto";
import { TErrorResponse } from "../interface/error.interface";

export const notFound = (req: Request, res: Response) => {
    const requestId =
        typeof res.locals.requestId === "string"
            ? res.locals.requestId
            : randomUUID();

    res.setHeader("X-Request-Id", requestId);

    const response: TErrorResponse = {
        statusCode: status.NOT_FOUND,
        success: false,
        code: "ROUTE_NOT_FOUND",
        message: `Route ${req.method} ${req.path} was not found.`,
        errorSources: [],
        fieldErrors: {},
        retryable: false,
        requestId,
    };

    res.status(status.NOT_FOUND).json(response);
};
