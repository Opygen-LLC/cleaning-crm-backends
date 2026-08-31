#!/usr/bin/env node
const origin = (process.env.API_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const url = process.env.OPERATIONAL_HEALTH_URL || `${origin}/health/operations`;
const token = process.env.PERFORMANCE_METRICS_TOKEN;

if (!token) throw new Error("PERFORMANCE_METRICS_TOKEN is required");

const response = await fetch(url, {
  headers: { "x-monitoring-token": token, accept: "application/json" },
  signal: AbortSignal.timeout(15_000),
});
const body = await response.json().catch(() => ({}));
console.log(JSON.stringify(body, null, 2));
if (!response.ok || body?.data?.healthy === false) process.exit(45);
