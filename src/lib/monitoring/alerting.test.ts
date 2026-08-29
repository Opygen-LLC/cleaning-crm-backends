import { beforeEach, describe, expect, it } from "vitest";
import { forceCloseRedisCircuit } from "../cache/redisCircuitBreaker";
import { getMonitoringAlerts } from "./alerting";
import { recordRequestMetric, resetPerformanceMetricsForTests } from "./performanceMetrics";
import { recordProductReliabilitySignal, resetProductReliabilityMetricsForTests } from "./productReliabilityMetrics";

beforeEach(() => { resetPerformanceMetricsForTests(); resetProductReliabilityMetricsForTests(); forceCloseRedisCircuit(); });

describe("Phase 7 monitoring alerts", () => {
  it("surfaces verification-session and missing-access-cookie signals without request payloads", () => {
    for (let index = 0; index < 30; index += 1) {
      recordRequestMetric({ method: "GET", route: "/api/v1/auth/session", statusCode: index < 6 ? 401 : 200, durationMs: 50, dbDurationMs: 10, market: "USA", authErrorCode: index === 0 ? "AUTH_VERIFICATION_SESSION_FAILED" : index < 6 ? "ACCESS_TOKEN_MISSING" : "AUTH_OK" });
    }
    const result = getMonitoringAlerts();
    expect(result.alerts.map((alert) => alert.code)).toEqual(expect.arrayContaining(["AUTH_VERIFICATION_SESSION_FAILED", "ACCESS_TOKEN_MISSING"]));
  });

  it("alerts on a 5xx spike after the minimum rolling-window sample size", () => {
    for (let index = 0; index < 30; index += 1) recordRequestMetric({ method: "GET", route: "/api/v1/dashboard/overview", statusCode: index < 5 ? 503 : 200, durationMs: 80, dbDurationMs: 20, market: "UK" });
    expect(getMonitoringAlerts().alerts.some((alert) => alert.code === "HTTP_5XX_SPIKE")).toBe(true);
  });
  it("fails the release health gate on critical onboarding contract and transaction signals", () => {
    recordProductReliabilitySignal({
      code: "SERVICE_CATALOG_SCHEMA_MISMATCH", releaseVersion: "sha-1", route: "/admin/onboarding",
      onboardingStep: "services", requestId: "req-1", traceId: "trace-1",
    });
    recordProductReliabilitySignal({
      code: "ONBOARDING_TRANSACTION_FAILURE", releaseVersion: "sha-1", route: "/api/v1/admin/onboarding/services",
      onboardingStep: "services", requestId: "req-2", traceId: "trace-2",
    });

    const codes = getMonitoringAlerts().alerts.map((alert) => alert.code);
    expect(codes).toEqual(expect.arrayContaining(["API_CONTRACT_MISMATCH", "ONBOARDING_TRANSACTION_FAILURE"]));
  });

});
