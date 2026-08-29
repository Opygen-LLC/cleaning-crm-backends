import { getPerformanceSnapshot } from "./performanceMetrics";
import { getProductReliabilitySnapshot } from "./productReliabilityMetrics";
import { getRedisCircuitSnapshot } from "../cache/redisCircuitBreaker";
import {
  ALERT_401_RATE_PERCENT,
  ALERT_5XX_RATE_PERCENT,
  ALERT_ACCESS_TOKEN_MISSING_COUNT,
  ALERT_AUTH_REFRESH_LOOP_COUNT,
  ALERT_BAD_GATEWAY_RATE_PERCENT,
  ALERT_CHUNK_LOAD_ERROR_COUNT,
  ALERT_CONTRACT_MISMATCH_COUNT,
  ALERT_DB_P95_MS,
  ALERT_MIN_REQUESTS,
  ALERT_ONBOARDING_RENDER_ERROR_COUNT,
  ALERT_ONBOARDING_TRANSACTION_FAILURE_COUNT,
  ALERT_OTP_FAILURE_RATE_PERCENT,
  ALERT_P95_MS,
  ALERT_REFRESH_FAILURE_RATE_PERCENT,
  ALERT_WEBSITE_PREVIEW_FAILURE_COUNT,
} from "../../config/ENV";

export type MonitoringAlert = {
  code: string;
  severity: "warning" | "critical";
  value: number;
  threshold: number;
  message: string;
};

export const getMonitoringAlerts = () => {
  const snapshot = getPerformanceSnapshot();
  const productReliability = getProductReliabilitySnapshot();
  const window = snapshot.window;
  const alerts: MonitoringAlert[] = [];
  const enough = window.requestCount >= ALERT_MIN_REQUESTS;
  const push = (condition: boolean, alert: MonitoringAlert) => {
    if (condition) alerts.push(alert);
  };

  push(enough && window.error5xxRate >= ALERT_5XX_RATE_PERCENT, {
    code: "HTTP_5XX_SPIKE", severity: "critical", value: window.error5xxRate,
    threshold: ALERT_5XX_RATE_PERCENT, message: "5xx error rate is above the release threshold",
  });
  push(enough && window.badGatewayRate >= ALERT_BAD_GATEWAY_RATE_PERCENT, {
    code: "HTTP_502_503_SPIKE", severity: "critical", value: window.badGatewayRate,
    threshold: ALERT_BAD_GATEWAY_RATE_PERCENT, message: "502/503 rate is elevated",
  });
  push(enough && window.auth401Rate >= ALERT_401_RATE_PERCENT, {
    code: "AUTH_401_SPIKE", severity: "warning", value: window.auth401Rate,
    threshold: ALERT_401_RATE_PERCENT, message: "401 responses are elevated",
  });
  push(enough && window.p95Ms >= ALERT_P95_MS, {
    code: "P95_LATENCY_SPIKE", severity: "warning", value: window.p95Ms,
    threshold: ALERT_P95_MS, message: "Request P95 latency is elevated",
  });
  push(enough && window.databaseP95Ms >= ALERT_DB_P95_MS, {
    code: "DATABASE_QUERY_SLOWDOWN", severity: "warning", value: window.databaseP95Ms,
    threshold: ALERT_DB_P95_MS, message: "Database time P95 is elevated",
  });
  push(window.refreshFailureRate >= ALERT_REFRESH_FAILURE_RATE_PERCENT && window.requestCount >= ALERT_MIN_REQUESTS, {
    code: "REFRESH_FAILURE_SPIKE", severity: "critical", value: window.refreshFailureRate,
    threshold: ALERT_REFRESH_FAILURE_RATE_PERCENT, message: "Refresh-token failures are elevated",
  });
  push(window.otpFailureRate >= ALERT_OTP_FAILURE_RATE_PERCENT && window.requestCount >= ALERT_MIN_REQUESTS, {
    code: "OTP_VERIFICATION_FAILURE_SPIKE", severity: "warning", value: window.otpFailureRate,
    threshold: ALERT_OTP_FAILURE_RATE_PERCENT, message: "OTP verification/resend failures are elevated",
  });
  push(window.authSignals.verificationSessionFailed > 0, {
    code: "AUTH_VERIFICATION_SESSION_FAILED", severity: "critical", value: window.authSignals.verificationSessionFailed,
    threshold: 0, message: "Verified users failed to establish a browser session",
  });
  push(window.authSignals.accessTokenMissing >= ALERT_ACCESS_TOKEN_MISSING_COUNT, {
    code: "ACCESS_TOKEN_MISSING", severity: "warning", value: window.authSignals.accessTokenMissing,
    threshold: ALERT_ACCESS_TOKEN_MISSING_COUNT, message: "Authenticated routes are receiving requests without the access cookie",
  });

  const counts = productReliability.counts;
  push(
    counts.ONBOARDING_STEP_RENDER_ERROR + counts.ONBOARDING_PREVIEW_RENDER_ERROR >= ALERT_ONBOARDING_RENDER_ERROR_COUNT,
    {
      code: "ONBOARDING_RENDER_ERRORS", severity: "critical",
      value: counts.ONBOARDING_STEP_RENDER_ERROR + counts.ONBOARDING_PREVIEW_RENDER_ERROR,
      threshold: ALERT_ONBOARDING_RENDER_ERROR_COUNT,
      message: "Onboarding step/preview render errors detected in the rolling window",
    },
  );
  push(counts.CHUNK_LOAD_ERROR >= ALERT_CHUNK_LOAD_ERROR_COUNT, {
    code: "ONBOARDING_CHUNK_LOAD_ERRORS", severity: "critical", value: counts.CHUNK_LOAD_ERROR,
    threshold: ALERT_CHUNK_LOAD_ERROR_COUNT, message: "Onboarding dynamic chunk failures detected",
  });
  const contractMismatchCount =
    counts.BOOTSTRAP_SCHEMA_MISMATCH +
    counts.SERVICE_CATALOG_SCHEMA_MISMATCH +
    counts.BOOKING_SETUP_SCHEMA_MISMATCH;
  push(contractMismatchCount >= ALERT_CONTRACT_MISMATCH_COUNT, {
    code: "API_CONTRACT_MISMATCH", severity: "critical", value: contractMismatchCount,
    threshold: ALERT_CONTRACT_MISMATCH_COUNT, message: "Critical onboarding API contract drift detected",
  });
  push(counts.ONBOARDING_TRANSACTION_FAILURE >= ALERT_ONBOARDING_TRANSACTION_FAILURE_COUNT, {
    code: "ONBOARDING_TRANSACTION_FAILURE", severity: "critical", value: counts.ONBOARDING_TRANSACTION_FAILURE,
    threshold: ALERT_ONBOARDING_TRANSACTION_FAILURE_COUNT, message: "Atomic onboarding transaction failures detected",
  });
  push(counts.WEBSITE_PREVIEW_FAILURE >= ALERT_WEBSITE_PREVIEW_FAILURE_COUNT, {
    code: "WEBSITE_PREVIEW_FAILURE", severity: "critical", value: counts.WEBSITE_PREVIEW_FAILURE,
    threshold: ALERT_WEBSITE_PREVIEW_FAILURE_COUNT, message: "Website preview failures detected",
  });
  push(counts.AUTH_REFRESH_LOOP >= ALERT_AUTH_REFRESH_LOOP_COUNT, {
    code: "AUTH_REFRESH_LOOP", severity: "critical", value: counts.AUTH_REFRESH_LOOP,
    threshold: ALERT_AUTH_REFRESH_LOOP_COUNT, message: "A protected request returned 401 after a successful refresh",
  });

  const redis = getRedisCircuitSnapshot();
  push(redis.state === "open", {
    code: "REDIS_UNAVAILABLE", severity: "warning", value: redis.consecutiveFailures,
    threshold: 0, message: "Redis circuit breaker is open; PostgreSQL fallbacks are active",
  });

  return {
    generatedAt: new Date().toISOString(),
    healthy: alerts.length === 0,
    alerts,
    window,
    productReliability,
    redisCircuit: redis,
  };
};
