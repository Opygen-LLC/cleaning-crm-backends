import { createHash } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import logger from "../lib/logger";
import {
  DEPLOYMENT_PROFILE,
  NODE_ENV,
  RELEASE_VERSION,
  SLOW_REQUEST_THRESHOLD_MS,
} from "../config/ENV";
import { recordRequestMetric } from "../lib/monitoring/performanceMetrics";
import { getRequestTrace } from "../lib/monitoring/requestTrace";
import { resolveRequestGeography } from "../lib/monitoring/requestGeography";
import { observeRequestStorm } from "../lib/monitoring/requestStormDetector";
import { evaluateEndpointQueryBudget, getEndpointQueryBudget } from "../lib/monitoring/queryBudgets";

const compactPath = (req: Request): string => {
  const base = req.baseUrl || "";
  const routePath = typeof req.route?.path === "string" ? req.route.path : "";
  if (routePath) return `${base}${routePath}` || "/";

  return req.path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\/[0-9]{2,}(?=\/|$)/g, "/:id")
    .slice(0, 300);
};

const hashIdentity = (value: string | null | undefined): string | null => {
  if (!value) return null;
  return createHash("sha256").update(`observability:v1:${value}`).digest("hex").slice(0, 20);
};

const round = (value: number) => Math.round(value * 10) / 10;

const logRequestResponse = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const start = getRequestTrace()?.startedAtNs ?? process.hrtime.bigint();
  // Keep a direct reference to the mutable ALS trace state. Some Node/Express
  // event-emitter callbacks can execute outside the active ALS lookup context;
  // the object itself remains valid and continues accumulating timings.
  const requestTrace = getRequestTrace();
  let durationMs = 0;
  let responseBytes = 0;
  let routeLabel: string | null = null;
  let jsonStarted: bigint | null = null;
  const originalJson = res.json;
  const originalSend = res.send;
  const originalWrite = res.write;
  const originalEnd = res.end;
  const originalWriteHead = res.writeHead;
  // Express json() serializes before calling send(). Time that actual boundary
  // without a second JSON.stringify (which can be expensive or mutate toJSON).
  res.json = function(this: Response, body: unknown) {
    const previous = jsonStarted;
    jsonStarted = process.hrtime.bigint();
    try { return originalJson.call(this, body); }
    finally { jsonStarted = previous; }
  } as Response["json"];
  res.send = function(this: Response, body: unknown) {
    if (jsonStarted !== null) {
      const encodeMs = Number(process.hrtime.bigint() - jsonStarted) / 1_000_000;
      if (requestTrace && !requestTrace.closed) requestTrace.serializationDurationMs += encodeMs;
      jsonStarted = null;
    }
    return originalSend.call(this, body);
  } as Response["send"];
  const countChunk = (chunk: unknown, encoding?: unknown) => {
    if (req.method === "HEAD" || res.statusCode === 204 || res.statusCode === 304) return;
    if (typeof chunk === "string") responseBytes += Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
    else if (ArrayBuffer.isView(chunk)) responseBytes += chunk.byteLength;
  };
  res.write = function(this: Response, ...args: unknown[]) {
    countChunk(args[0], args[1]);
    return (originalWrite as (...args: unknown[]) => boolean).apply(this, args);
  } as Response["write"];
  res.end = function(this: Response, ...args: unknown[]) {
    countChunk(args[0], args[1]);
    return (originalEnd as (...args: unknown[]) => Response).apply(this, args);
  } as Response["end"];
  res.writeHead = function(this: Response, ...args: unknown[]) {
    durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (requestTrace && !requestTrace.closed) requestTrace.handlerDurationMs = Math.max(0, durationMs - requestTrace.serializationDurationMs);
    const rounded = round(durationMs);
    routeLabel = compactPath(req);
    if (!res.headersSent) {
      const trace = getRequestTrace() ?? requestTrace;
      const route = routeLabel ?? compactPath(req);
      const queryBudget = getEndpointQueryBudget(req.method, route);
      if (NODE_ENV !== "production" || process.env.E2E_TEST_HOOKS_ENABLED === "true") {
        res.setHeader("X-DB-Query-Count", String(trace?.dbQueryCount ?? 0));
        res.setHeader("X-Redis-Command-Count", String(trace?.redisCommandCount ?? 0));
        res.setHeader("X-Redis-Errors", String(trace?.redisErrors ?? 0));
        res.setHeader("X-Application-Cache", (trace?.responseCacheMisses ?? 0) > 0 ? "miss" : (trace?.responseCacheHits ?? 0) > 0 ? "hit" : "unclassified");
        if (queryBudget !== null) res.setHeader("X-DB-Query-Budget", String(queryBudget));
      }
      const timings = [`app;dur=${rounded};desc="API middleware to response headers"`];
      if (trace) {
        timings.push(`auth;dur=${round(trace.authDurationMs)}`);
        timings.push(`db.query;dur=${round(trace.dbDurationMs)}`);
        timings.push(`db.pool;dur=${round(trace.dbPoolWaitMs)}`);
        timings.push(`redis;dur=${round(trace.redisDurationMs)}`);
        timings.push(`handler;dur=${round(trace.handlerDurationMs)}`);
        if (trace.serializationDurationMs > 0) timings.push(`serialize;dur=${round(trace.serializationDurationMs)}`);
        if (trace.queueDurationMs > 0) timings.push(`queue;dur=${round(trace.queueDurationMs)}`);
        if (trace.externalDurationMs > 0) timings.push(`external;dur=${round(trace.externalDurationMs)}`);
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
        [existingTimings, ...timings].filter(Boolean).join(", "),
      );
    }
    return (originalWriteHead as (...args: unknown[]) => Response).apply(this, args);
  } as Response["writeHead"];

  res.once("finish", () => {
    durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const rounded = round(durationMs);
    const route = routeLabel ?? compactPath(req);
    const trace = getRequestTrace() ?? requestTrace;
    const geography = resolveRequestGeography(req);

    const isAuthRoute = (req.originalUrl || req.path).split("?", 1)[0].startsWith("/api/v1/auth");
    const authErrorCode = isAuthRoute
      ? typeof res.locals.authErrorCode === "string" && res.locals.authErrorCode.trim()
        ? res.locals.authErrorCode.trim()
        : res.statusCode < 400
          ? "AUTH_OK"
          : `HTTP_${res.statusCode}`
      : null;

    recordRequestMetric({
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationMs,
      dbDurationMs: trace?.dbDurationMs,
      dbQueryCount: trace?.dbQueryCount,
      dbPoolWaitMs: trace?.dbPoolWaitMs,
      dbPoolAcquisitions: trace?.dbPoolAcquisitions,
      redisCommandCount: trace?.redisCommandCount,
      redisDurationMs: trace?.redisDurationMs,
      redisHits: trace?.redisHits,
      redisMisses: trace?.redisMisses,
      authDurationMs: trace?.authDurationMs,
      cacheHits: trace?.responseCacheHits,
      cacheMisses: trace?.responseCacheMisses,
      serializationDurationMs: trace?.serializationDurationMs,
      externalDurationMs: trace?.externalDurationMs,
      responseBytes,
      market: geography.market,
      authErrorCode,
    });

    if (trace) trace.closed = true;
    const level = durationMs >= SLOW_REQUEST_THRESHOLD_MS || res.statusCode >= 500 ? "warn" : "info";
    const requestId = trace?.requestId ?? (typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown");
    const traceId = trace?.traceId ?? (typeof res.locals.traceId === "string" ? res.locals.traceId : "unknown");
    const tenantId = req.user?.adminId ?? req.user?.id ?? null;
    const userId = req.user?.id ?? null;
    const storm = observeRequestStorm({
      identity: userId ?? tenantId,
      method: req.method,
      route,
      statusCode: res.statusCode,
    });
    if (storm) {
      logger.warn("request_storm_detected", {
        event: "request_storm_detected",
        code: storm.code,
        method: storm.method,
        route: storm.route,
        statusCode: storm.statusCode,
        count: storm.count,
        windowMs: storm.windowMs,
        requestId,
        traceId,
        userHash: hashIdentity(userId),
        tenantHash: hashIdentity(tenantId),
        releaseSha: RELEASE_VERSION,
      });
    }
    const queryBudgetViolation = evaluateEndpointQueryBudget(req.method, route, trace?.dbQueryCount ?? 0);
    if (queryBudgetViolation) {
      logger.warn("endpoint_query_budget_exceeded", {
        event: "endpoint_query_budget_exceeded",
        code: "QUERY_BUDGET_EXCEEDED",
        method: req.method,
        route,
        queryCount: trace?.dbQueryCount ?? 0,
        budget: queryBudgetViolation.budget,
        exceededBy: queryBudgetViolation.exceededBy,
        requestId,
        traceId,
        releaseSha: RELEASE_VERSION,
      });
    }
    const cacheAttempts = (trace?.responseCacheHits ?? 0) + (trace?.responseCacheMisses ?? 0);
    const redisAttempts = (trace?.redisHits ?? 0) + (trace?.redisMisses ?? 0);

    if (NODE_ENV !== "production" && process.env.PERFORMANCE_JSON_LOGS !== "true") {
      const devLevel = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      const dbMs = round(trace?.dbDurationMs ?? 0);
      const dbQueries = trace?.dbQueryCount ?? 0;
      const redisMs = round(trace?.redisDurationMs ?? 0);
      const queueMs = round(trace?.queueDurationMs ?? 0);
      const poolWaitMs = round(trace?.dbPoolWaitMs ?? 0);
      const parts = [`${req.method} ${route} → ${res.statusCode} in ${rounded}ms`];
      if (dbQueries > 0) {
        const slowest = trace?.slowestDbQuery;
        if (dbQueries === 1 && slowest) {
          parts.push(`DB ${dbMs}ms (${slowest.operation} ${slowest.table})`);
        } else if (slowest) {
          parts.push(`DB ${dbMs}ms/${dbQueries}q (slowest ${round(slowest.durationMs)}ms ${slowest.table})`);
        } else {
          parts.push(`DB ${dbMs}ms/${dbQueries}q`);
        }
        if (poolWaitMs > 0) parts.push(`DB pool ${poolWaitMs}ms`);
      }
      if ((trace?.redisCommandCount ?? 0) > 0) parts.push(`Redis ${redisMs}ms`);
      if (queueMs > 0) parts.push(`Queue ${queueMs}ms`);
      if ((trace?.externalDurationMs ?? 0) > 0) parts.push(`External ${round(trace?.externalDurationMs ?? 0)}ms`);
      if (devLevel !== "info") parts.push(`request ${requestId.slice(0, 8)}`);
      logger.log(devLevel, parts.join(" · "));
      return;
    }

    logger.log(level, "http_request", {
      event: "http_request",
      route,
      method: req.method,
      statusCode: res.statusCode,
      totalDurationMs: rounded,
      measurementClock: "api-middleware-to-finish",
      responseBytesClock: "node-response-body-excluding-headers",
      dbPoolAcquisitions: trace?.dbPoolAcquisitions ?? 0,
      dbPoolErrors: trace?.dbPoolErrors ?? 0,
      dbPoolAcquisitionMs: round(trace?.dbPoolWaitMs ?? 0),
      dbDurationMs: round(trace?.dbDurationMs ?? 0),
      "db.query_ms": round(trace?.dbDurationMs ?? 0),
      "db.pool_wait_ms": round(trace?.dbPoolWaitMs ?? 0),
      dbQueryCount: trace?.dbQueryCount ?? 0,
      slowestDbQuery: trace?.slowestDbQuery
        ? {
            durationMs: round(trace.slowestDbQuery.durationMs),
            operation: trace.slowestDbQuery.operation,
            table: trace.slowestDbQuery.table,
          }
        : null,
      redisDurationMs: round(trace?.redisDurationMs ?? 0),
      redis_ms: round(trace?.redisDurationMs ?? 0),
      redisCommandCount: trace?.redisCommandCount ?? 0,
      redisHits: trace?.redisHits ?? 0,
      redisMisses: trace?.redisMisses ?? 0,
      redisErrors: trace?.redisErrors ?? 0,
      redisHitRate: redisAttempts > 0 ? round(((trace?.redisHits ?? 0) / redisAttempts) * 100) : null,
      responseCacheHits: trace?.responseCacheHits ?? 0,
      responseCacheMisses: trace?.responseCacheMisses ?? 0,
      responseCacheHitRate: cacheAttempts > 0 ? round(((trace?.responseCacheHits ?? 0) / cacheAttempts) * 100) : null,
      authDurationMs: round(trace?.authDurationMs ?? 0),
      queueDurationMs: round(trace?.queueDurationMs ?? 0),
      queue_ms: round(trace?.queueDurationMs ?? 0),
      handler_ms: round(trace?.handlerDurationMs ?? 0),
      serialization_ms: round(trace?.serializationDurationMs ?? 0),
      externalDurationMs: round(trace?.externalDurationMs ?? 0),
      responseBytes,
      requestId,
      traceId,
      userHash: hashIdentity(userId),
      tenantHash: hashIdentity(tenantId),
      releaseSha: RELEASE_VERSION,
      deploymentProfile: DEPLOYMENT_PROFILE,
      market: geography.market,
      countryCode: geography.countryCode,
      countrySource: geography.source,
      ...(isAuthRoute ? { authErrorCode } : {}),
      processRole: process.env.PROCESS_ROLE || "api",
    });
  });

  next();
};

export default logRequestResponse;
