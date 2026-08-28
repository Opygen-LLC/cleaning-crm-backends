import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => {
  console.error(`PHASE6_OBSERVABILITY_FAIL: ${message}`);
  process.exitCode = 1;
};

const requestContext = read("src/middlewares/requestContext.ts");
for (const marker of ["X-Trace-Id", "x-trace-id", "traceparent", "runWithRequestTrace"]) {
  if (!requestContext.toLowerCase().includes(marker.toLowerCase())) fail(`request context missing ${marker}`);
}

const logger = read("src/middlewares/logger.middleware.ts");
for (const field of [
  "http_request", "route", "method", "statusCode", "totalDurationMs",
  "dbDurationMs", "dbQueryCount", "redisDurationMs", "redisHits", "redisMisses",
  "responseCacheHits", "responseCacheMisses", "authDurationMs", "queueDurationMs",
  "externalDurationMs", "requestId", "traceId", "tenantHash", "releaseSha",
]) {
  if (!logger.includes(field)) fail(`structured HTTP event missing ${field}`);
}
if (/Math\.random\(\).*REQUEST_LOG_SAMPLE_RATE|REQUEST_LOG_SAMPLE_RATE/.test(logger)) {
  fail("Phase 6 must emit one structured http_request event per completed request");
}

const trace = read("src/lib/monitoring/requestTrace.ts");
for (const marker of ["recordTraceDatabaseQuery", "recordTraceRedisCommand", "recordTraceResponseCache", "traceAsyncOperation", "getTracePropagationMetadata"]) {
  if (!trace.includes(marker)) fail(`request trace missing ${marker}`);
}

const perf = read("src/lib/monitoring/performanceMetrics.ts");
for (const marker of ["p50Ms", "p95Ms", "p99Ms", "errorRate", "hitRate", "queryCount"]) {
  if (!perf.includes(marker)) fail(`performance snapshot missing ${marker}`);
}

const server = read("src/server.ts");
for (const marker of ["/livez", "/readyz", "/health/details", "/health/performance", "monitoringTokenAllowed", "X-Trace-Id", "Traceparent"]) {
  if (!server.includes(marker)) fail(`server observability contract missing ${marker}`);
}
if (!server.includes('return res.status(404).json({ success: false, message: "Not found" })')) {
  fail("detailed health endpoints must fail closed without the monitoring token");
}

const telemetryRoute = read("src/modules/Telemetry/telemetry.routes.ts");
if (!telemetryRoute.includes("checkAuth") || !telemetryRoute.includes("telemetryRateLimit")) {
  fail("dashboard client telemetry must be authenticated and rate-limited");
}
const telemetryValidation = read("src/modules/Telemetry/telemetry.validation.ts");
if (!telemetryValidation.includes(".strict()") || !telemetryValidation.includes("relatedTraceId")) {
  fail("client telemetry payload must be strict and trace-correlated");
}

const outbox = read("src/lib/outbox/authEmailOutbox.ts");
const worker = read("src/workers/emailOutbox.worker.ts");
if (!outbox.includes("getTracePropagationMetadata") || !worker.includes("runWithRequestTrace")) {
  fail("durable outbox must propagate request/trace ids into workers");
}

const dashboardService = read("src/modules/Dashboard/dashboard.service.ts");
const dashboardRoutes = read("src/modules/Dashboard/dashboard.routes.ts");
if (!dashboardService.includes("includeRevenueInsight") || !dashboardRoutes.includes("/revenue-insight")) {
  fail("revenue analytics must be isolated from the operational dashboard query");
}

const gcpGuide = read("deploy/gcp/OBSERVABILITY.md");
for (const marker of ["Cloud Logging", "p50", "p95", "p99", "/readyz", "/health/performance", "traceId", "releaseSha"]) {
  if (!gcpGuide.includes(marker)) fail(`Google Cloud observability guide missing ${marker}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Phase 6 backend observability verification passed.");
