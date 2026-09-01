import { beforeEach, describe, expect, it } from "vitest";
import { getPerformanceSnapshot, recordRequestMetric, resetPerformanceMetricsForTests } from "./performanceMetrics";

describe("Phase 4 performance telemetry", () => {
  beforeEach(() => resetPerformanceMetricsForTests());

  it("captures latency phases, query counts, cache behavior and response bytes per route", () => {
    for (const ms of [40, 50, 60, 70, 80]) {
      recordRequestMetric({
        method: "GET", route: "/api/v1/client", statusCode: 200, durationMs: ms,
        dbDurationMs: 12, dbQueryCount: 2, redisDurationMs: 2, redisHits: 1,
        authDurationMs: 3, serializationDurationMs: 1.5, cacheHits: 1, externalDurationMs: 0, responseBytes: 2048,
      });
    }
    const route = getPerformanceSnapshot().requests.topSlowRoutes.find((row) => row.route === "GET /api/v1/client");
    expect(route).toBeTruthy();
    expect(route?.p50Ms).toBe(60);
    expect(route?.p95Ms).toBe(80);
    expect(route?.database.queryCount).toBe(10);
    expect(route?.serialization.p95Ms).toBe(1.5);
    expect(route?.responseBytes.avgBytes).toBe(2048);
    expect(route?.responseBytes.p95Bytes).toBe(2048);
    expect(route?.responseCache.hitRate).toBe(100);
  });
});
