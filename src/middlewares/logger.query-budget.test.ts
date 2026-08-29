import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  log: vi.fn(),
  metric: vi.fn(),
  trace: {
    requestId: "req-budget-1",
    traceId: "0123456789abcdef0123456789abcdef",
    authDurationMs: 1,
    dbDurationMs: 3,
    dbPoolWaitMs: 0,
    dbQueryCount: 3,
    redisDurationMs: 0,
    redisCommandCount: 0,
    redisHits: 0,
    redisMisses: 0,
    redisErrors: 0,
    responseCacheHits: 0,
    responseCacheMisses: 0,
    queueDurationMs: 0,
    externalDurationMs: 0,
    handlerDurationMs: 0,
    serializationDurationMs: 0,
    slowestDbQuery: null,
  },
}));

vi.mock("../lib/logger", () => ({ default: { log: mocks.log, warn: mocks.warn } }));
vi.mock("../lib/monitoring/performanceMetrics", () => ({ recordRequestMetric: mocks.metric }));
vi.mock("../lib/monitoring/requestTrace", () => ({
  getRequestTrace: () => mocks.trace,
  recordTraceRequestPhases: vi.fn(),
}));
vi.mock("../lib/monitoring/requestGeography", () => ({
  resolveRequestGeography: () => ({ market: "USA", countryCode: "US", source: "test" }),
}));
vi.mock("../config/ENV", () => ({
  DEPLOYMENT_PROFILE: "test",
  NODE_ENV: "test",
  RELEASE_VERSION: "phase3-test",
  SLOW_REQUEST_THRESHOLD_MS: 1_000,
}));

import logRequestResponse from "./logger.middleware";

class FakeResponse extends EventEmitter {
  statusCode = 200;
  locals: Record<string, unknown> = { requestId: "req-budget-1", traceId: "0123456789abcdef0123456789abcdef" };
  headersSent = false;
  headers = new Map<string, unknown>();
  send = vi.fn((body: unknown) => body);
  setHeader(name: string, value: unknown) { this.headers.set(name.toLowerCase(), value); return this; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
}

describe("query-budget request integration", () => {
  it("exposes query counts in non-production and emits a structured violation", () => {
    const req = {
      method: "GET",
      originalUrl: "/api/v1/auth/session",
      path: "/session",
      baseUrl: "/api/v1/auth",
      route: { path: "/session" },
      user: { id: "user-1", adminId: "admin-1" },
      get: () => undefined,
    } as unknown as Request;
    const res = new FakeResponse() as unknown as Response;
    const next = vi.fn();

    logRequestResponse(req, res, next);
    (res.send as unknown as (body: unknown) => unknown)({ success: true });
    (res as unknown as EventEmitter).emit("finish");

    expect((res as unknown as FakeResponse).headers.get("x-db-query-count")).toBe("3");
    expect((res as unknown as FakeResponse).headers.get("x-db-query-budget")).toBe("2");
    expect(mocks.warn).toHaveBeenCalledWith(
      "endpoint_query_budget_exceeded",
      expect.objectContaining({
        code: "QUERY_BUDGET_EXCEEDED",
        route: "/api/v1/auth/session",
        queryCount: 3,
        budget: 2,
      }),
    );
  });
});
