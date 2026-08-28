import { beforeEach, describe, expect, it } from "vitest";
import { getPerformanceSnapshot, recordRequestMetric, resetPerformanceMetricsForTests } from "./performanceMetrics";

describe("performanceMetrics", () => {
  beforeEach(() => resetPerformanceMetricsForTests());
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
        market: "USA",
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

    const usa = snapshot.geography.markets.find((entry) => entry.market === "USA");
    expect(usa?.count).toBeGreaterThanOrEqual(20);
    expect(usa?.p50Ms).toBeGreaterThan(0);
    expect(usa?.p95Ms).toBeGreaterThanOrEqual(usa?.p50Ms ?? 0);
  });
});
