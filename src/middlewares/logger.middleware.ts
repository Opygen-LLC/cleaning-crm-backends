import { Request, Response, NextFunction } from "express";
import logger from "../lib/logger";
import {
  NODE_ENV,
  REQUEST_LOG_SAMPLE_RATE,
  SLOW_REQUEST_THRESHOLD_MS,
} from "../config/ENV";
import { recordRequestMetric } from "../lib/monitoring/performanceMetrics";
import { getRequestTrace } from "../lib/monitoring/requestTrace";

const compactPath = (req: Request): string => {
  const base = req.baseUrl || "";
  const routePath = typeof req.route?.path === "string" ? req.route.path : "";
  if (routePath) return `${base}${routePath}` || "/";

  // Fallback for middleware/not-found paths. Redact ids to keep the metrics
  // bucket count bounded and avoid exposing tenant/customer identifiers.
  return req.path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\/[0-9]{2,}(?=\/|$)/g, "/:id")
    .slice(0, 300);
};

const logRequestResponse = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const start = process.hrtime.bigint();
  const originalSend = res.send.bind(res);
  let durationMs = 0;
  let routeLabel: string | null = null;

  res.send = ((body: unknown) => {
    durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const rounded = Math.round(durationMs * 10) / 10;
    routeLabel = compactPath(req);
    if (!res.headersSent) {
      const trace = getRequestTrace();
      const timings = [`app;dur=${rounded}`];
      if (trace) {
        timings.push(`db;dur=${Math.round(trace.dbDurationMs * 10) / 10}`);
        timings.push(`redis;dur=${Math.round(trace.redisDurationMs * 10) / 10}`);
      }
      res.setHeader("X-Response-Time", `${rounded}ms`);
      const existingServerTiming = res.getHeader("Server-Timing");
      const existingTimings = Array.isArray(existingServerTiming)
        ? existingServerTiming.join(", ")
        : typeof existingServerTiming === "string"
          ? existingServerTiming
          : "";
      res.setHeader(
        "Server-Timing",
        [existingTimings, ...timings].filter(Boolean).join(", ")
      );
    }
    return originalSend(body);
  }) as Response["send"];

  res.once("finish", () => {
    if (!durationMs) durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const rounded = Math.round(durationMs * 10) / 10;
    const route = routeLabel ?? compactPath(req);
    recordRequestMetric({ method: req.method, route, statusCode: res.statusCode, durationMs });

    const shouldLog =
      NODE_ENV !== "production" ||
      durationMs >= SLOW_REQUEST_THRESHOLD_MS ||
      res.statusCode >= 500 ||
      req.method !== "GET" ||
      Math.random() < REQUEST_LOG_SAMPLE_RATE;

    if (!shouldLog) return;

    const trace = getRequestTrace();
    const level = durationMs >= SLOW_REQUEST_THRESHOLD_MS || res.statusCode >= 500 ? "warn" : "info";
    const requestId =
      typeof res.locals.requestId === "string" ? res.locals.requestId : "no-request-id";
    const db = trace ? `${trace.dbQueryCount}q/${Math.round(trace.dbDurationMs * 10) / 10}ms` : "n/a";
    const cache = trace ? `${trace.redisCommandCount}cmd/${Math.round(trace.redisDurationMs * 10) / 10}ms` : "n/a";
    logger[level](`[${requestId}] ${req.method} ${route} ${res.statusCode} - ${rounded}ms db=${db} redis=${cache}`);
  });

  next();
};

export default logRequestResponse;
