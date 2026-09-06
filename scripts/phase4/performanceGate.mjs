#!/usr/bin/env node
/** Existing load entrypoint, corrected to use actual website routes and the API
 * finish clock. --evaluate reuses the recorded requests after a cloud log export.
 * Does not manufacture cold misses by appending a query nonce. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluateMeasurements, indexServerLogs, WEBSITE_BUDGETS, normalizeRoute } from "../performance/websiteBudgets.mjs";
const exec = promisify(execFile);
const integer = (value, fallback, min, max) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Integer setting must be ${min}..${max}`);
  return result;
};
const json = path => JSON.parse(readFileSync(path, "utf8"));
const write = (path, data) => { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 }); };
export async function runPerformanceGate(env = process.env, args = process.argv.slice(2)) {
  const output = env.PERF_REPORT_PATH || "artifacts/phase5-performance.json";
  const rawOutput = env.PERF_REQUESTS_PATH || "artifacts/phase5-requests.json";
  const minimumSamples = integer(env.PERF_MIN_SAMPLES, 100, 3, 10000);
  let requests;
  if (args.includes("--evaluate")) requests = json(rawOutput).requests;
  else {
    if (env.PERF_STAGING_ACK !== "STAGING_ONLY") throw new Error("PERF_STAGING_ACK=STAGING_ONLY is required. Never load-test production with this runner.");
    const url = new URL(env.PERF_API_URL || env.E2E_API_URL || "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || !["/", "", "/api/v1", "/api/v1/"].includes(url.pathname)) throw new Error("PERF_API_URL must be an API origin or /api/v1, without credentials/query");
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Use HTTPS staging, or loopback for local fixtures");
    const base = `${url.origin}/api/v1`, origin = new URL(env.PERF_ORIGIN || env.E2E_FRONTEND_URL || "").origin;
    const samples = integer(env.PERF_SAMPLES, 100, 3, 10000), concurrency = integer(env.PERF_CONCURRENCY, 8, 1, 100);
    const timeout = integer(env.PERF_TIMEOUT_MS, 15000, 1000, 120000);
    const scenarios = (env.PERF_SCENARIOS || "warm,concurrent").split(",");
    if (scenarios.some(mode => !["warm", "cold", "concurrent", "redis-outage"].includes(mode))) throw new Error("Unknown scenario");
    if (scenarios.includes("cold") && !env.PERF_COLD_RESET_SCRIPT) throw new Error("Cold requires a reviewed local executable PERF_COLD_RESET_SCRIPT (isolated staging caches only)");
    if (scenarios.includes("redis-outage") && env.PERF_REDIS_OUTAGE_ACK !== "ISOLATED_REDIS_DISABLED") throw new Error("Disable the isolated staging Redis through the deployment fault injector and acknowledge it");
    const email = env.PERF_EMAIL || env.E2E_ADMIN_EMAIL, password = env.PERF_PASSWORD || env.E2E_ADMIN_PASSWORD;
    if (!email || !password) throw new Error("PERF_EMAIL/PERF_PASSWORD are required");
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-CSRF-Protection": "1" },
      body: JSON.stringify({ email, password }), redirect: "manual", signal: AbortSignal.timeout(timeout) });
    await login.arrayBuffer();
    if (!login.ok) throw new Error(`Staging login failed (${login.status}); response body intentionally omitted`);
    const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    if (!cookie) throw new Error("Staging login returned no session cookie");
    const host = env.PERF_CANONICAL_HOST;
    if (!host || !/^[a-z0-9.-]+$/i.test(host)) throw new Error("PERF_CANONICAL_HOST is required for the host-resolver baseline");
    const paths = (env.PERF_ENDPOINTS || ["/website/status", "/website/editor?surface=content", "/website/studio/overview?includeMetrics=false",
      "/admin/bootstrap?surface=onboarding", "/admin/onboarding/services", "/dashboard/overview", "/client?page=1&limit=20",
      `/website/public/resolve-host/${encodeURIComponent(host)}`].join(",")).split(",").map(value => value.trim());
    requests = env.PERF_APPEND_REQUESTS === "true" ? json(rawOutput).requests : [];
    const request = async ({ path, method = "GET", body }, scenario, resetEvidence = null) => {
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) throw new Error("Unsafe relative endpoint");
      const requestId = randomUUID(), started = performance.now();
      let response;
      try {
        response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: origin,
          "Content-Type": "application/json", "X-CSRF-Protection": "1", "X-Request-ID": requestId },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(timeout) });
        const bytes = (await response.arrayBuffer()).byteLength;
        const timing = response.headers.get("server-timing")?.match(/(?:^|,)\s*app;dur=([0-9.]+)/);
        const row = { path: path.split("?")[0], method, scenario, resetEvidence, requestId: response.headers.get("x-request-id") || requestId,
          status: response.status, remoteClientMs: performance.now() - started, apiHeadersMs: timing ? Number(timing[1]) : null,
          remoteResponseBytes: bytes, applicationCache: response.headers.get("x-application-cache") };
        return row;
      } catch {
        return { path: path.split("?")[0], method, scenario, resetEvidence, requestId, status: 0,
          remoteClientMs: performance.now() - started, apiHeadersMs: null, failure: "transport-failed-or-timed-out" };
      }
    };
    for (const scenario of scenarios) for (const path of paths) {
      if (scenario === "warm" || scenario === "concurrent") await request({ path }, "prime");
      for (let offset = 0; offset < samples; offset += scenario === "concurrent" ? concurrency : 1) {
        let evidence = null;
        if (scenario === "cold") {
          const { stdout } = await exec(resolve(env.PERF_COLD_RESET_SCRIPT), [], { timeout, maxBuffer: 65536, env });
          const result = JSON.parse(stdout.trim());
          if (result.scope !== "isolated-staging" || result.reset !== true || typeof result.evidenceId !== "string") throw new Error("Cache reset adapter did not confirm isolated reset");
          evidence = result.evidenceId.slice(0, 100);
        }
        const count = scenario === "concurrent" ? Math.min(concurrency, samples - offset) : 1;
        requests.push(...await Promise.all(Array.from({ length: count }, () => request({ path }, scenario, evidence))));
      }
      write(rawOutput, { schemaVersion: 1, generatedAt: new Date().toISOString(), source: "live-http", concurrency, samples, requests });
    }
    if (env.PERF_MUTATION_PLAN) {
      if (env.PERF_ALLOW_WRITES !== "STAGING_ONLY") throw new Error("Explicit write acknowledgement required for a reviewed synthetic mutation plan");
      // One entry = one prepared, revision-valid write. Provision a tenant cohort
      // for statistically useful samples; never loop a stale DTO until it works.
      const entries = json(env.PERF_MUTATION_PLAN);
      if (!Array.isArray(entries) || entries.length > 10000) throw new Error("Invalid mutation plan");
      for (const entry of entries) {
        if (!["PUT /website/editor", "PUT /admin/onboarding/services", "PUT /admin/onboarding/step", "POST /website/publish", "POST /website/launch"].includes(`${entry.method} ${entry.path}`)) throw new Error("Mutation plan contains an unsupported endpoint");
        requests.push(await request(entry, "warm"));
      }
      write(rawOutput, { schemaVersion: 1, generatedAt: new Date().toISOString(), source: "live-http", requests });
    }
  }
  const logs = env.PERF_SERVER_LOGS_PATH ? indexServerLogs(readFileSync(env.PERF_SERVER_LOGS_PATH, "utf8")) : new Map();
  const report = evaluateMeasurements(requests, logs, { minimumSamples, outageP95: env.PERF_OUTAGE_P95_MS ? integer(env.PERF_OUTAGE_P95_MS, 1000, 1, 120000) : null });
  report.serverLogsProvided = Boolean(env.PERF_SERVER_LOGS_PATH);
  report.scenariosObserved = [...new Set(requests.map(request => request.scenario))];
  report.fullScenarioMatrix = ["warm", "cold", "concurrent", "redis-outage"].every(scenario => report.scenariosObserved.includes(scenario));
  const observed = new Set(requests.map(request => `${request.method} ${normalizeRoute(request.path)}`));
  report.missingRequiredEndpoints = Object.keys(WEBSITE_BUDGETS).filter(key => !observed.has(key));
  const seenScenarios = new Set(requests.map(request => `${request.method} ${normalizeRoute(request.path)} ${request.scenario}`));
  report.missingReadScenarios = Object.keys(WEBSITE_BUDGETS).filter(key => key.startsWith("GET ")).flatMap(key =>
    ["warm", "cold", "concurrent", "redis-outage"].filter(scenario => !seenScenarios.has(`${key} ${scenario}`)).map(scenario => `${key} ${scenario}`));
  // Writes use separately prepared, revision-valid samples; publication/typing
  // race correctness is a distinct required E2E suite, not a fast-409 budget pass.
  report.releaseGatePassed = report.passed && report.fullScenarioMatrix && report.missingRequiredEndpoints.length === 0 && report.missingReadScenarios.length === 0;
  write(output, report);
  console.log(`Website performance report written. Server targets passed: ${report.passed}; full scenario matrix: ${report.fullScenarioMatrix}`);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPerformanceGate().then(report => { if (!report.releaseGatePassed) process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
