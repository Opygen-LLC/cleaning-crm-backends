/** Targets, not claims of measured production latency. Versioned with the API
 * route surface; only middleware-to-finish log measurements are gate inputs. */
export const PERFORMANCE_SCHEMA_VERSION = 1;
export const WEBSITE_BUDGETS = Object.freeze({
  "GET /api/v1/website/public/resolve-host/:host": { warm: { p50: 50, p95: 100 }, cold: { p95: 250 } },
  "GET /api/v1/website/status": { warm: { p50: 50, p95: 100 }, cold: { p95: 250 } },
  "GET /api/v1/website/editor": { warm: { p95: 100 }, cold: { p95: 250 } },
  "GET /api/v1/website/studio/overview": { warm: { p95: 100 }, cold: { p95: 250 } },
  "GET /api/v1/admin/bootstrap": { warm: { p95: 100 }, cold: { p95: 250 } },
  "GET /api/v1/admin/onboarding/services": { warm: { p95: 100 }, cold: { p95: 250 } },
  "GET /api/v1/dashboard/overview": { warm: { p95: 100 }, cold: { p95: 250 } },
  "GET /api/v1/client": { warm: { p95: 100 }, cold: { p95: 250 } },
  "PUT /api/v1/website/editor": { warm: { p95: 350 }, cold: { p95: 350 } },
  "PUT /api/v1/admin/onboarding/step": { warm: { p95: 350 }, cold: { p95: 350 } },
  "PUT /api/v1/admin/onboarding/services": { warm: { p95: 1000 }, cold: { p95: 1000 } },
  "POST /api/v1/website/launch": { warm: { p95: 1000 }, cold: { p95: 1000 } },
  "POST /api/v1/website/publish": { warm: { p95: 1000 }, cold: { p95: 1000 } },
});
export function normalizeRoute(path) {
  const route = new URL(path, "http://route.invalid").pathname.replace(/\/+$/, "");
  const full = route.startsWith("/api/v1/") ? route : `/api/v1${route}`;
  return full.replace(/(\/website\/public\/resolve-host\/)[^/]+$/, "$1:host");
}
export function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? Math.round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] * 100) / 100 : null;
  return { count: sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.length ? sorted.at(-1) : null };
}
export function indexServerLogs(text) {
  const records = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed; try { parsed = JSON.parse(line); } catch { continue; }
    const value = parsed.jsonPayload ?? parsed;
    const row = value.metadata && value.event !== "http_request" ? value.metadata : value;
    if (row.event !== "http_request" || !row.requestId || row.measurementClock !== "api-middleware-to-finish") continue;
    const existing = records.get(row.requestId);
    // Request IDs must be unique. Never quietly pick one of conflicting log rows.
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) throw new Error("Conflicting request IDs in server log export");
    records.set(row.requestId, row);
  }
  return records;
}
export function evaluateMeasurements(requests, logs, { minimumSamples = 100, outageP95 = null } = {}) {
  const groups = new Map();
  for (const request of requests) {
    const key = `${request.method} ${normalizeRoute(request.path)} ${request.scenario}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { method: request.method, route: normalizeRoute(request.path), scenario: request.scenario, rows: [] });
    group.rows.push({ request, log: logs.get(request.requestId) });
  }
  const reports = [];
  for (const group of groups.values()) {
    const violations = [], rows = group.rows;
    const matched = rows.filter(({ request, log }) => log && log.method === request.method && log.route === group.route && log.statusCode === request.status);
    if (matched.length !== rows.length) violations.push(`Missing or mismatched API finish logs: ${rows.length - matched.length}`);
    const success = matched.filter(row => row.request.status >= 200 && row.request.status < 300);
    const unsuccessful = rows.filter(row => row.request.status < 200 || row.request.status >= 300);
    if (unsuccessful.length) violations.push(`Non-2xx responses: ${unsuccessful.length}; fast denials do not pass a latency budget`);
    if (success.length < minimumSamples) violations.push(`Insufficient successful samples: ${success.length}/${minimumSamples}`);
    const field = key => percentiles(success.map(({ log }) => log[key]));
    const requiredMetrics = ["totalDurationMs", "dbQueryCount", "dbDurationMs", "dbPoolAcquisitionMs", "redisCommandCount", "redisDurationMs", "externalDurationMs", "responseBytes"];
    for (const metric of requiredMetrics) if (success.some(({ log }) => !Number.isFinite(log[metric]) || log[metric] < 0)) violations.push(`Missing or invalid API metric: ${metric}`);
    const server = field("totalDurationMs");
    const cacheGroups = Object.fromEntries(["hit", "miss", "unclassified"].map(state => [state, percentiles(success.filter(({ log }) =>
      ((log.responseCacheMisses ?? 0) > 0 ? "miss" : (log.responseCacheHits ?? 0) > 0 ? "hit" : "unclassified") === state).map(({ log }) => log.totalDurationMs))]));
    if (group.scenario === "cold" && rows.some(({ request }) => !request.resetEvidence)) violations.push("Cold scenario has no verified cache-reset evidence");
    if (group.scenario === "cold" && group.route.includes("resolve-host") && success.some(({ log }) => !(log.responseCacheMisses > 0))) violations.push("Cold host scenario included a routing-cache hit");
    if (group.scenario === "redis-outage" && !matched.some(({ log }) => log.redisErrors > 0)) violations.push("No observed Redis errors; outage scenario is unverified");
    const configured = WEBSITE_BUDGETS[`${group.method} ${group.route}`];
    const budget = group.scenario === "redis-outage" ? (outageP95 === null ? null : { p95: outageP95 }) : configured?.[group.scenario === "cold" ? "cold" : "warm"];
    if (!budget) violations.push("No agreed budget for this endpoint/scenario");
    for (const [percentile, limit] of Object.entries(budget ?? {})) if (server[percentile] !== null && server[percentile] > limit) violations.push(`${percentile} ${server[percentile]}ms > ${limit}ms`);
    reports.push({ method: group.method, route: group.route, scenario: group.scenario,
      requestCount: rows.length, errorCount: unsuccessful.length, serverClock: "api-middleware-to-finish", budget,
      serverMs: server, cacheStates: cacheGroups,
      remoteClientMs: percentiles(rows.map(({ request }) => request.remoteClientMs)),
      apiHeadersMs: percentiles(rows.map(({ request }) => request.apiHeadersMs)),
      sqlCount: field("dbQueryCount"), sqlMs: field("dbDurationMs"), poolAcquisitionMs: field("dbPoolAcquisitionMs"),
      redisCount: field("redisCommandCount"), redisMs: field("redisDurationMs"), externalMs: field("externalDurationMs"),
      responseBytes: field("responseBytes"), violations, passed: violations.length === 0 });
  }
  return { schemaVersion: PERFORMANCE_SCHEMA_VERSION, generatedAt: new Date().toISOString(),
    measurement: "Targets apply only to API middleware-to-finish; remote/BFF/browser clocks are reported separately. Overlapping spans must not be summed.",
    minimumSamples, passed: reports.length > 0 && reports.every(report => report.passed), endpoints: reports };
}
