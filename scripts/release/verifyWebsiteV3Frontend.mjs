#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WEBSITE_RUNTIME_CONTRACT_VERSION = 1;
export const WEBSITE_PROJECTION_SCHEMA_VERSION = 1;
export const WEBSITE_FOUNDATION_VERSION = "3.0.0";
export const WEBSITE_FOUNDATION_TEMPLATE_KEYS = [
  "clean-modern@3.0.0",
  "premium-home@3.0.0",
  "commercial-pro@3.0.0",
  "local-cleaning@3.0.0",
];

const assertObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

const normalizeSha = (value) => String(value || "").trim().toLowerCase();

export function gitShaMatches(actualValue, expectedValue) {
  const actual = normalizeSha(actualValue);
  const expected = normalizeSha(expectedValue);
  if (!expected) return true;
  if (!actual || actual === "unknown") return false;
  if (actual === expected) return true;
  const shorter = actual.length <= expected.length ? actual : expected;
  const longer = actual.length > expected.length ? actual : expected;
  return shorter.length >= 7 && longer.startsWith(shorter);
}

export function validateFrontendWebsiteRuntime(payload, { expectedSha } = {}) {
  const root = assertObject(payload, "frontend /api/version response");
  const runtime = assertObject(root.websiteRuntime, "frontend websiteRuntime");

  if (runtime.contractVersion !== WEBSITE_RUNTIME_CONTRACT_VERSION) {
    throw new Error(
      `Frontend website runtime contract ${String(runtime.contractVersion)} is not supported; expected ${WEBSITE_RUNTIME_CONTRACT_VERSION}`,
    );
  }
  if (runtime.projectionSchemaVersion !== WEBSITE_PROJECTION_SCHEMA_VERSION) {
    throw new Error(
      `Frontend projection schema ${String(runtime.projectionSchemaVersion)} is not compatible with backend schema ${WEBSITE_PROJECTION_SCHEMA_VERSION}`,
    );
  }
  if (runtime.foundationVersion !== WEBSITE_FOUNDATION_VERSION) {
    throw new Error(
      `Frontend website foundation ${String(runtime.foundationVersion)} is not ${WEBSITE_FOUNDATION_VERSION}`,
    );
  }

  if (!Array.isArray(runtime.templateKeys)) {
    throw new Error("Frontend websiteRuntime.templateKeys must be an array");
  }
  if (!Array.isArray(runtime.foundationTemplateKeys)) {
    throw new Error("Frontend websiteRuntime.foundationTemplateKeys must be an array");
  }

  const allKeys = new Set(runtime.templateKeys.filter((item) => typeof item === "string"));
  const foundationKeys = new Set(runtime.foundationTemplateKeys.filter((item) => typeof item === "string"));
  const missing = WEBSITE_FOUNDATION_TEMPLATE_KEYS.filter(
    (key) => !allKeys.has(key) || !foundationKeys.has(key),
  );
  if (missing.length) {
    throw new Error(`Frontend is missing required v3 website renderers: ${missing.join(", ")}`);
  }

  if (expectedSha && !gitShaMatches(root.gitSha, expectedSha)) {
    throw new Error(
      `Frontend release SHA mismatch: deployed=${String(root.gitSha || "unknown")} expected=${String(expectedSha)}`,
    );
  }

  return {
    version: String(root.version || "unknown"),
    gitSha: String(root.gitSha || "unknown"),
    foundationVersion: WEBSITE_FOUNDATION_VERSION,
    templateKeys: WEBSITE_FOUNDATION_TEMPLATE_KEYS.slice(),
  };
}

export function normalizeFrontendOrigin(rawValue, { allowInsecure = false } = {}) {
  const raw = String(rawValue || "").trim();
  if (!raw) throw new Error("WEBSITE_FRONTEND_RUNTIME_URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WEBSITE_FRONTEND_RUNTIME_URL must be an absolute http(s) URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Frontend runtime URL must use http(s)");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Frontend runtime URL must not contain credentials, query parameters or fragments");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local && !allowInsecure) {
    throw new Error("Frontend runtime verification requires HTTPS outside localhost");
  }
  url.pathname = "/";
  return url.origin;
}

export async function verifyFrontendWebsiteRuntime({
  origin,
  expectedSha,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  allowInsecure = false,
} = {}) {
  const frontendOrigin = normalizeFrontendOrigin(origin, { allowInsecure });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${frontendOrigin}/api/version`, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read frontend /api/version: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Frontend /api/version returned HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Frontend /api/version did not return valid JSON");
  }
  return validateFrontendWebsiteRuntime(payload, { expectedSha });
}

async function main() {
  const origin =
    process.env.WEBSITE_FRONTEND_RUNTIME_URL ||
    process.env.PRODUCTION_FRONTEND_URL ||
    process.env.E2E_FRONTEND_URL ||
    process.env.FRONTEND_URL;
  const expectedSha = process.env.RELEASE_FRONTEND_SHA || process.env.E2E_EXPECT_FRONTEND_SHA || undefined;
  const result = await verifyFrontendWebsiteRuntime({
    origin,
    expectedSha,
    allowInsecure: process.env.WEBSITE_FRONTEND_ALLOW_HTTP === "true",
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[website-v3-frontend] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
