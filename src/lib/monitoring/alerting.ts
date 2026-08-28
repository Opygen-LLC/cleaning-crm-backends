import { getPerformanceSnapshot } from "./performanceMetrics";
import { getRedisCircuitSnapshot } from "../cache/redisCircuitBreaker";
import {
  ALERT_401_RATE_PERCENT, ALERT_5XX_RATE_PERCENT, ALERT_BAD_GATEWAY_RATE_PERCENT, ALERT_ACCESS_TOKEN_MISSING_COUNT,
  ALERT_DB_P95_MS, ALERT_MIN_REQUESTS, ALERT_OTP_FAILURE_RATE_PERCENT,
  ALERT_P95_MS, ALERT_REFRESH_FAILURE_RATE_PERCENT,
} from "../../config/ENV";

export type MonitoringAlert = { code: string; severity: "warning" | "critical"; value: number; threshold: number; message: string };

export const getMonitoringAlerts = () => {
  const snapshot = getPerformanceSnapshot(); const window = snapshot.window; const alerts: MonitoringAlert[] = [];
  const enough = window.requestCount >= ALERT_MIN_REQUESTS;
  const push = (condition: boolean, alert: MonitoringAlert) => { if (condition) alerts.push(alert); };
  push(enough && window.error5xxRate >= ALERT_5XX_RATE_PERCENT, { code: "HTTP_5XX_SPIKE", severity: "critical", value: window.error5xxRate, threshold: ALERT_5XX_RATE_PERCENT, message: "5xx error rate is above the release threshold" });
  push(enough && window.badGatewayRate >= ALERT_BAD_GATEWAY_RATE_PERCENT, { code: "HTTP_502_503_SPIKE", severity: "critical", value: window.badGatewayRate, threshold: ALERT_BAD_GATEWAY_RATE_PERCENT, message: "502/503 rate is elevated" });
  push(enough && window.auth401Rate >= ALERT_401_RATE_PERCENT, { code: "AUTH_401_SPIKE", severity: "warning", value: window.auth401Rate, threshold: ALERT_401_RATE_PERCENT, message: "401 responses are elevated" });
  push(enough && window.p95Ms >= ALERT_P95_MS, { code: "P95_LATENCY_SPIKE", severity: "warning", value: window.p95Ms, threshold: ALERT_P95_MS, message: "Request P95 latency is elevated" });
  push(enough && window.databaseP95Ms >= ALERT_DB_P95_MS, { code: "DATABASE_QUERY_SLOWDOWN", severity: "warning", value: window.databaseP95Ms, threshold: ALERT_DB_P95_MS, message: "Database time P95 is elevated" });
  push(window.refreshFailureRate >= ALERT_REFRESH_FAILURE_RATE_PERCENT && window.requestCount >= ALERT_MIN_REQUESTS, { code: "REFRESH_FAILURE_SPIKE", severity: "critical", value: window.refreshFailureRate, threshold: ALERT_REFRESH_FAILURE_RATE_PERCENT, message: "Refresh-token failures are elevated" });
  push(window.otpFailureRate >= ALERT_OTP_FAILURE_RATE_PERCENT && window.requestCount >= ALERT_MIN_REQUESTS, { code: "OTP_VERIFICATION_FAILURE_SPIKE", severity: "warning", value: window.otpFailureRate, threshold: ALERT_OTP_FAILURE_RATE_PERCENT, message: "OTP verification/resend failures are elevated" });
  push(window.authSignals.verificationSessionFailed > 0, { code: "AUTH_VERIFICATION_SESSION_FAILED", severity: "critical", value: window.authSignals.verificationSessionFailed, threshold: 0, message: "Verified users failed to establish a browser session" });
  push(window.authSignals.accessTokenMissing >= ALERT_ACCESS_TOKEN_MISSING_COUNT, { code: "ACCESS_TOKEN_MISSING", severity: "warning", value: window.authSignals.accessTokenMissing, threshold: ALERT_ACCESS_TOKEN_MISSING_COUNT, message: "Authenticated routes are receiving requests without the access cookie" });
  const redis = getRedisCircuitSnapshot();
  push(redis.state === "open", { code: "REDIS_UNAVAILABLE", severity: "warning", value: redis.consecutiveFailures, threshold: 0, message: "Redis circuit breaker is open; PostgreSQL fallbacks are active" });
  return { generatedAt: new Date().toISOString(), healthy: alerts.length === 0, alerts, window, redisCircuit: redis };
};
