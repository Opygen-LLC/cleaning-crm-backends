#!/usr/bin/env node
/** Read the existing token-protected process diagnostics and measure this
 * diagnostic host's DNS/TCP route. Region labels are NOT provider verification.
 * Never emits DB/Redis passwords, IPs, DSNs, monitoring tokens or response bodies. */
import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { writeFileSync } from "node:fs";
import { percentiles } from "./websiteBudgets.mjs";
const env = process.env;
if (!env.PERF_API_URL || !env.PERFORMANCE_METRICS_TOKEN) throw new Error("PERF_API_URL and PERFORMANCE_METRICS_TOKEN are required");
const api = new URL(env.PERF_API_URL);
if (api.username || api.password || api.search || api.hash || !/^https?:$/.test(api.protocol)) throw new Error("Invalid API URL");
if (api.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)) throw new Error("Monitoring tokens require HTTPS outside loopback");
const samples = [];
for (let i = 0; i < 20; i++) {
  const response = await fetch(`${api.origin}/health/performance`, { headers: { "x-monitoring-token": env.PERFORMANCE_METRICS_TOKEN }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Monitoring diagnostics failed (${response.status})`);
  const { data } = await response.json();
  samples.push({ at: new Date().toISOString(), pool: data.databasePool, runtime: data.runtime, infrastructure: data.infrastructure });
  if (i !== 19) await new Promise(resolve => setTimeout(resolve, 1000));
}
const tcp = (host, port) => new Promise((resolve, reject) => {
  const started = performance.now(), socket = createConnection({ host, port });
  socket.setTimeout(3000);
  socket.once("connect", () => { socket.destroy(); resolve(performance.now() - started); });
  socket.once("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
  socket.once("error", () => { socket.destroy(); reject(new Error("connect-failed")); });
});
const targets = [{ name: "api", host: api.hostname, port: Number(api.port || (api.protocol === "https:" ? 443 : 80)) }];
if (env.DATABASE_URL) { const db = new URL(env.DATABASE_URL); targets.push({ name: "postgresql", host: db.hostname, port: Number(db.port || 5432) }); }
if (env.REDIS_HOST) targets.push({ name: "redis", host: env.REDIS_HOST, port: Number(env.REDIS_PORT || 6379) });
const routes = [];
for (const target of targets) {
  const dns = [], connections = []; let errors = 0;
  for (let i = 0; i < 10; i++) {
    try { const started = performance.now(); await lookup(target.host); dns.push(performance.now() - started); connections.push(await tcp(target.host, target.port)); }
    catch { errors++; }
  }
  routes.push({ target: target.name, dnsMs: percentiles(dns), tcpConnectMs: percentiles(connections), errors });
}
writeFileSync(env.PERF_TOPOLOGY_REPORT || "phase5-topology.json", JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
  source: "live-process-and-diagnostic-host", regionVerification: "unverified-operator-must-attach-provider-resource-placement", samples, routes,
  caution: "A CLI probe is not an API pool measurement or a cross-region proof. Use the protected process snapshots under load and provider resource metadata. Do not raise pool or VM size from a quiet CLI run." }, null, 2), { mode: 0o600 });
