import { describe, expect, it } from "vitest";
import { getPerformanceSnapshot, recordRequestMetric } from "./performanceMetrics";

describe("performanceMetrics", () => {
  it("publishes p50/p95/p99 plus DB, Redis and response-cache diagnostics by route", () => {
    for (let index = 1; index <= 20; index += 1) {
      recordRequestMetric({
        method: "GET",
        route: "/admin/bootstrap-phase6-test",
        statusCode: index === 20 ? 500 : 200,
        durationMs: index,
        dbDurationMs: index / 2,
        dbQueryCount: 2,
        redisDurationMs: index / 10,
        redisHits: 2,
        redisMisses: 1,
        authDurationMs: 1,
        cacheHits: 1,
        cacheMisses: 1,
      });
    }

    const snapshot = getPerformanceSnapshot();
    const route = snapshot.requests.topSlowRoutes.find(
      (entry) => entry.route === "GET /admin/bootstrap-phase6-test",
    );

    expect(route).toBeDefined();
    expect(route?.p50Ms).toBeGreaterThan(0);
    expect(route?.p95Ms).toBeGreaterThanOrEqual(route?.p50Ms ?? 0);
    expect(route?.p99Ms).toBeGreaterThanOrEqual(route?.p95Ms ?? 0);
    expect(route?.database.p95Ms).toBeGreaterThan(0);
    expect(route?.database.queryCount).toBe(40);
    expect(route?.redis.hitRate).toBeCloseTo(66.67, 1);
    expect(route?.responseCache.hitRate).toBe(50);
    expect(route?.errorRate).toBe(5);
  });
});
