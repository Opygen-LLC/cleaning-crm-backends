import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import { runWithRequestTrace } from "../lib/monitoring/requestTrace";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_TRACE_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const W3C_TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

export const requestContext = (
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    const incoming = req.header("x-request-id")?.trim();
    const requestId =
        incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

    const incomingTrace = req.header("x-trace-id")?.trim();
    const traceparent = req.header("traceparent")?.trim();
    const parentMatch = traceparent?.match(W3C_TRACEPARENT);
    const traceId = incomingTrace && SAFE_TRACE_ID.test(incomingTrace)
        ? incomingTrace.replace(/-/g, "").toLowerCase()
        : parentMatch?.[1]?.toLowerCase() ?? randomUUID().replace(/-/g, "");

    res.locals.requestId = requestId;
    res.locals.traceId = traceId;
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Trace-Id", traceId);

    // AsyncLocalStorage keeps this id attached to Prisma/Redis work kicked off
    // by the request, so slow-query logs can be correlated without passing the
    // id through every service signature.
    runWithRequestTrace({ requestId, traceId }, next);
};
