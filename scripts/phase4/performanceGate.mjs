#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const base = (process.env.PERF_API_URL || process.env.E2E_API_URL || "").replace(/\/+$/, "");
const origin = (process.env.PERF_ORIGIN || process.env.E2E_FRONTEND_URL || "").replace(/\/+$/, "");
const email = process.env.PERF_EMAIL || process.env.E2E_ADMIN_EMAIL || "";
const password = process.env.PERF_PASSWORD || process.env.E2E_ADMIN_PASSWORD || "";
const samples = Math.max(3, Number(process.env.PERF_SAMPLES || 12));
const concurrency = Math.max(2, Number(process.env.PERF_CONCURRENCY || 8));
const warmP95Target = Number(process.env.PERF_WARM_P95_MS || 150);
const coldP95Target = Number(process.env.PERF_COLD_P95_MS || 250);
const concurrentP95Target = Number(process.env.PERF_CONCURRENT_P95_MS || 300);
const requireQueryHeaders = process.env.PERF_REQUIRE_QUERY_HEADERS !== "false";
const reportPath = process.env.PERF_REPORT_PATH || "phase4-performance-report.json";
const requireLargeTenant = process.env.PERF_REQUIRE_LARGE_TENANT === "true";
const largeTenantMinRows = Math.max(1, Number(process.env.PERF_MIN_LARGE_TENANT_ROWS || 500));
const largeTenantMinMatches = Math.max(1, Number(process.env.PERF_LARGE_TENANT_MIN_MATCHES || 1));
const largeTenantEndpoints = (process.env.PERF_LARGE_TENANT_ENDPOINTS || "/client?page=1&limit=1,/lead?page=1&limit=1,/booking?page=1&limit=1,/job?page=1&limit=1").split(",").map((x)=>x.trim()).filter(Boolean);

if (!base || !origin || !email || !password) {
  console.error("PERF_API_URL/E2E_API_URL, PERF_ORIGIN/E2E_FRONTEND_URL, PERF_EMAIL/E2E_ADMIN_EMAIL and password are required");
  process.exit(2);
}

const endpoints = (process.env.PERF_ENDPOINTS || [
  "/client?page=1&limit=20",
  "/lead?page=1&limit=20",
  "/lead/follow-ups?page=1&limit=20&scope=today",
  "/booking?page=1&limit=20",
  "/dashboard/overview",
  "/staff?page=1&limit=20",
  "/job?page=1&limit=20",
  "/invoice?page=1&limit=20",
  "/payment?page=1&limit=20",
].join(",")).split(",").map((x) => x.trim()).filter(Boolean);

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
};
const summary = (values) => ({
  p50: Math.round(percentile(values, 50) * 10) / 10,
  p95: Math.round(percentile(values, 95) * 10) / 10,
  p99: Math.round(percentile(values, 99) * 10) / 10,
  max: Math.round(Math.max(...values, 0) * 10) / 10,
});
const parseServerTiming = (header) => {
  const out = {};
  for (const part of String(header || "").split(",")) {
    const [name, ...attrs] = part.trim().split(";");
    const dur = attrs.map((x)=>x.trim()).find((x)=>x.startsWith("dur="));
    if (name && dur) out[name] = Number(dur.slice(4)) || 0;
  }
  return out;
};

let cookie = "";
const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", Origin: origin, "X-CSRF-Protection": "1" },
  body: JSON.stringify({ email, password }),
  redirect: "manual",
});
if (!login.ok) throw new Error(`performance login failed (${login.status}): ${await login.text()}`);
const setCookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")].filter(Boolean);
cookie = setCookies.map((value) => String(value).split(";",1)[0]).join("; ");
if (!cookie) throw new Error("performance login returned no auth cookies");

const getJson = async (path) => {
  const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie, Origin: origin }, cache: "no-store" });
  const body = await response.json().catch(()=>null);
  if (!response.ok) throw new Error(`${path} fixture check failed (${response.status}): ${JSON.stringify(body).slice(0,300)}`);
  return body;
};
const extractTotal = (body) => {
  const candidates=[body?.meta?.total,body?.data?.meta?.total,body?.data?.total,body?.total];
  const value=candidates.find((x)=>Number.isFinite(Number(x)));
  return value==null?null:Number(value);
};
const largeTenantCounts = {};
if (requireLargeTenant) {
  for (const path of largeTenantEndpoints) largeTenantCounts[path] = extractTotal(await getJson(path));
  const matches = Object.values(largeTenantCounts).filter((value)=>Number.isFinite(value) && value >= largeTenantMinRows).length;
  if (matches < largeTenantMinMatches) {
    throw new Error(`large-tenant gate failed: need ${largeTenantMinMatches} dataset(s) >= ${largeTenantMinRows} rows, got ${JSON.stringify(largeTenantCounts)}`);
  }
  console.log(`[phase4] large tenant fixture verified: ${JSON.stringify(largeTenantCounts)}`);
}

const requestOnce = async (path, nonce = "") => {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${nonce ? `${separator}__perf_nonce=${encodeURIComponent(nonce)}` : ""}`;
  const started = performance.now();
  const response = await fetch(url, { headers: { Cookie: cookie, Origin: origin }, cache: "no-store" });
  const body = new Uint8Array(await response.arrayBuffer());
  const elapsed = performance.now() - started;
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${new TextDecoder().decode(body).slice(0,300)}`);
  const queryCountRaw = response.headers.get("x-db-query-count");
  const queryBudgetRaw = response.headers.get("x-db-query-budget");
  if (requireQueryHeaders && (!queryCountRaw || !queryBudgetRaw)) throw new Error(`${path} missing X-DB-Query-Count/Budget headers`);
  const queryCount = queryCountRaw == null ? null : Number(queryCountRaw);
  const queryBudget = queryBudgetRaw == null ? null : Number(queryBudgetRaw);
  if (Number.isFinite(queryCount) && Number.isFinite(queryBudget) && queryCount > queryBudget) {
    throw new Error(`${path} query budget regression: ${queryCount} > ${queryBudget}`);
  }
  const timing = parseServerTiming(response.headers.get("server-timing"));
  return {
    elapsedMs: elapsed,
    queryCount,
    queryBudget,
    dbMs: timing["db.query"] ?? 0,
    redisMs: timing.redis ?? 0,
    authMs: timing.auth ?? 0,
    serializeMs: timing.serialize ?? 0,
    responseBytes: body.byteLength,
    cache: response.headers.get("x-response-cache") || "",
  };
};

const runSeries = async (path, mode) => {
  const rows = [];
  if (mode === "warm") await requestOnce(path);
  for (let i=0;i<samples;i++) rows.push(await requestOnce(path, mode === "cold" ? `${Date.now()}-${i}` : ""));
  return rows;
};
const runConcurrent = async (path) => {
  await requestOnce(path);
  const rows = [];
  for (let i=0;i<samples;i+=concurrency) {
    rows.push(...await Promise.all(Array.from({length: Math.min(concurrency, samples-i)}, () => requestOnce(path))));
  }
  return rows;
};
const metricSummary = (rows, field) => summary(rows.map((r)=>Number(r[field] || 0)));
const maxQueryCount = (rows) => Math.max(0, ...rows.map((r)=>Number(r.queryCount || 0)));

const report = { generatedAt: new Date().toISOString(), base, samples, concurrency, thresholds: { warmP95Target, coldP95Target, concurrentP95Target }, largeTenant: { required: requireLargeTenant, minimumRows: largeTenantMinRows, minimumMatches: largeTenantMinMatches, counts: largeTenantCounts }, endpoints: [] };
let failed = false;
for (const path of endpoints) {
  const cold = await runSeries(path, "cold");
  const warm = await runSeries(path, "warm");
  const concurrent = await runConcurrent(path);
  const row = {
    path,
    cold: { responseMs: metricSummary(cold,"elapsedMs"), dbMs: metricSummary(cold,"dbMs"), redisMs: metricSummary(cold,"redisMs"), authMs: metricSummary(cold,"authMs"), serializeMs: metricSummary(cold,"serializeMs"), responseBytes: metricSummary(cold,"responseBytes"), maxQueryCount: maxQueryCount(cold) },
    warm: { responseMs: metricSummary(warm,"elapsedMs"), dbMs: metricSummary(warm,"dbMs"), redisMs: metricSummary(warm,"redisMs"), authMs: metricSummary(warm,"authMs"), serializeMs: metricSummary(warm,"serializeMs"), responseBytes: metricSummary(warm,"responseBytes"), maxQueryCount: maxQueryCount(warm) },
    concurrent: { responseMs: metricSummary(concurrent,"elapsedMs"), dbMs: metricSummary(concurrent,"dbMs"), redisMs: metricSummary(concurrent,"redisMs"), authMs: metricSummary(concurrent,"authMs"), serializeMs: metricSummary(concurrent,"serializeMs"), responseBytes: metricSummary(concurrent,"responseBytes"), maxQueryCount: maxQueryCount(concurrent) },
  };
  const failures = [];
  if (row.warm.responseMs.p95 > warmP95Target) failures.push(`warm p95 ${row.warm.responseMs.p95}ms > ${warmP95Target}ms`);
  if (row.cold.responseMs.p95 > coldP95Target) failures.push(`cold p95 ${row.cold.responseMs.p95}ms > ${coldP95Target}ms`);
  if (row.concurrent.responseMs.p95 > concurrentP95Target) failures.push(`concurrent p95 ${row.concurrent.responseMs.p95}ms > ${concurrentP95Target}ms`);
  row.failures = failures;
  report.endpoints.push(row);
  failed ||= failures.length > 0;
  console.log(`${failures.length ? "FAIL" : "PASS"} ${path} warm=${row.warm.responseMs.p95}ms cold=${row.cold.responseMs.p95}ms concurrent=${row.concurrent.responseMs.p95}ms q=${row.warm.maxQueryCount}`);
}
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`Phase 4 performance report: ${reportPath}`);
if (failed) process.exitCode = 1;
