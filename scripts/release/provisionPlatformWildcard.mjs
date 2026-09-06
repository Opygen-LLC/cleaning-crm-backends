#!/usr/bin/env node
/**
 * One platform deployment operation, NEVER called by registration or launch.
 * Dry-run by default. Vercel-managed DNS/TLS only; tenant custom domains retain
 * their existing verification/provisioning lifecycle.
 */
import { resolveNs, resolve4, resolve6 } from "node:dns/promises";
import { domainToASCII } from "node:url";
import { connect } from "node:tls";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const apply = process.argv.includes("--apply");
const normalizeHost = value => {
  const host = domainToASCII((value ?? "").trim().toLowerCase().replace(/\.$/, ""));
  if (!host || host.length > 253 || !host.includes(".") || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Supply a valid DNS hostname, without a scheme, port or wildcard");
  }
  return host;
};
const base = normalizeHost(process.env.WEBSITE_BASE_DOMAIN);
const zone = normalizeHost(process.env.PLATFORM_DNS_ZONE);
if (base !== zone && !base.endsWith(`.${zone}`)) throw new Error("WEBSITE_BASE_DOMAIN must be within PLATFORM_DNS_ZONE");
const project = process.env.PLATFORM_FRONTEND_PROJECT_ID;
const token = process.env.VERCEL_ACCESS_TOKEN;
const teamId = process.env.VERCEL_TEAM_ID;
if (!project || !token) throw new Error("Require PLATFORM_FRONTEND_PROJECT_ID (the Next.js FRONTEND project) and VERCEL_ACCESS_TOKEN");
const report = { schemaVersion: 1, provider: "vercel", mode: apply ? "apply" : "dry-run", base, zone, project,
  startedAt: new Date().toISOString(), domains: [], ready: false };

async function api(method, path, body) {
  const url = new URL(`https://api.vercel.com${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const data = await response.json().catch(() => null);
  if (!response.ok && response.status !== 404) {
    // Do not print arbitrary provider response bodies (could contain secrets).
    throw new Error(`Vercel ${method} ${path} failed: HTTP ${response.status}, code ${String(data?.error?.code ?? "unknown").slice(0, 100)}`);
  }
  return { status: response.status, data };
}
const domainPath = name => `/v9/projects/${encodeURIComponent(project)}/domains/${encodeURIComponent(name)}`;
async function ensureDomain(name) {
  let found = await api("GET", domainPath(name));
  const item = { name, existed: found.status !== 404, action: "none", verified: false };
  report.domains.push(item);
  if (found.status === 404) {
    item.action = apply ? "create" : "would-create";
    if (!apply) return;
    await api("POST", `/v10/projects/${encodeURIComponent(project)}/domains`, { name });
    found = await api("GET", domainPath(name));
  }
  if (found.status === 404) throw new Error(`Domain ${name} was not assigned after creation; re-run to verify`);
  if (found.data?.redirect || found.data?.gitBranch || found.data?.customEnvironmentId) {
    throw new Error(`Domain ${name} is redirected or bound to a branch/custom environment. Refusing to change its existing routing`);
  }
  item.verified = found.data?.verified === true;
  if (apply && !item.verified) throw new Error(`Ownership of ${name} is not verified. Complete the Vercel domain ownership challenge; then re-run. DNS/TLS readiness has NOT been confirmed`);
}
function verifyTls(host) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: true });
    socket.setTimeout(15_000, () => socket.destroy(new Error("Wildcard TLS handshake timed out")));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const result = { host, authorized: socket.authorized, validTo: cert.valid_to, subjectAltName: cert.subjectaltname };
      socket.end();
      if (!result.authorized) reject(new Error("Wildcard TLS verification failed")); else resolve(result);
    });
  });
}
try {
  const projectResult = await api("GET", `/v9/projects/${encodeURIComponent(project)}`);
  if (projectResult.status === 404 || projectResult.data?.framework !== "nextjs") {
    throw new Error("Refusing to provision: PLATFORM_FRONTEND_PROJECT_ID must identify the existing Next.js frontend project, not the backend API project");
  }
  const nameservers = await resolveNs(zone);
  report.nameservers = nameservers;
  // Changing nameservers automatically can destroy mail/other service records.
  // Require prior zone delegation and migration of all existing DNS records.
  if (nameservers.length < 2 || !nameservers.every(ns => /^ns[0-9]+\.vercel-dns\.com\.?$/i.test(ns))) {
    throw new Error("Wildcard managed TLS requires Vercel-authoritative DNS. Migrate existing DNS records safely and delegate PLATFORM_DNS_ZONE to the Vercel nameservers first. No registrar/nameserver changes were attempted");
  }
  await ensureDomain(base);
  await ensureDomain(`*.${base}`);
  if (report.domains.every(d => d.existed || apply)) {
    // A random label proves wildcard coverage rather than one tenant's record.
    const host = `wildcard-check-${randomUUID().slice(0, 8)}.${base}`;
    const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
    report.dnsProbe = { host, addresses: [v4, v6].flatMap(r => r.status === "fulfilled" ? r.value : []) };
    if (!report.dnsProbe.addresses.length) throw new Error("Wildcard DNS is not resolvable yet. Do not enable launch traffic; re-run verification after propagation");
    report.tlsProbe = await verifyTls(host);
    report.ready = report.domains.every(d => d.verified) && report.tlsProbe.authorized;
  }
  if (apply && !report.ready) throw new Error("Wildcard assignment exists but DNS/TLS readiness is not confirmed; retry verification");
} catch (error) {
  report.failure = error instanceof Error ? error.message : "Provisioning failed";
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const json = JSON.stringify(report, null, 2) + "\n";
  if (process.env.PLATFORM_WILDCARD_REPORT) writeFileSync(process.env.PLATFORM_WILDCARD_REPORT, json, { mode: 0o600 });
  process.stdout.write(json);
}
