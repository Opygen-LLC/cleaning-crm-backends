import { Request, Response } from "express";
import status from "http-status";
import { sendStructuredError } from "../shared/sendStructuredError";

export const notFound = (req: Request, res: Response) =>
    sendStructuredError(res, {
        statusCode: status.NOT_FOUND,
        code: "ROUTE_NOT_FOUND",
        message: `Route ${req.method} ${req.path} was not found.`,
        fieldErrors: {},
        retryable: false,
    }, req);
