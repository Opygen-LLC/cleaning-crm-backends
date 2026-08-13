import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const requestContext = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    const incoming = req.header("x-request-id")?.trim();
    const requestId =
        incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
};
