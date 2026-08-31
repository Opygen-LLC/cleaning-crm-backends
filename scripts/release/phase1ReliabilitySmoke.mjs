#!/usr/bin/env node
const api = (process.env.PHASE1_SMOKE_API_URL || "").replace(/\/+$/, "");
const origin = (process.env.PHASE1_SMOKE_ORIGIN || "").replace(/\/+$/, "");
const email = process.env.AUTH_SMOKE_EMAIL || "";
const password = process.env.AUTH_SMOKE_PASSWORD || "";
const requirePublishedWebsite = process.env.PHASE1_REQUIRE_PUBLISHED_WEBSITE === "true";

for (const [key, value] of Object.entries({ PHASE1_SMOKE_API_URL: api, PHASE1_SMOKE_ORIGIN: origin, AUTH_SMOKE_EMAIL: email, AUTH_SMOKE_PASSWORD: password })) {
  if (!value) {
    console.error(`${key} is required for Phase 1 reliability smoke.`);
    process.exit(2);
  }
}

const jar = new Map();
const ingestCookies = (headers) => {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const row of values) {
    const pair = row.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value) jar.set(key, value); else jar.delete(key);
  }
};
const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");

const call = async (path, init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  headers.set("Origin", origin);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (["POST", "PUT", "PATCH", "DELETE"].includes((init.method || "GET").toUpperCase())) {
    headers.set("X-CSRF-Protection", "1");
  }
  if (jar.size) headers.set("Cookie", cookieHeader());
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers,
    body: init.body === undefined || typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    redirect: "manual",
  });
  ingestCookies(response.headers);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status} ${payload?.code || payload?.message || ""} requestId=${payload?.requestId || "unknown"}`);
  }
  return payload?.data ?? payload;
};

try {
  const login = await call("/auth/login", { method: "POST", body: { email, password } });
  if (login?.sessionCreated !== true) throw new Error("login did not create a session");

  await call("/notification");
  const overview = await call("/website/studio/overview");
  // Keep the legacy bootstrap healthy during the compatibility window, while
  // explicitly exercising every isolated editor surface used by the UI.
  await call("/website/studio");
  for (const surface of ["content", "templates", "branding", "booking", "seo", "domain", "analytics", "history"]) {
    await call(`/website/editor?surface=${surface}`);
  }
  await call("/website/booking-setup");
  await call("/website/domains");
  await call("/website/templates");
  await call("/website/google-analytics/status");

  const website = overview?.website;
  if (!website?.id) throw new Error("Website Studio overview did not return website.id");
  if (website.status === "PUBLISHED") {
    await call(`/website/public/by-id/${encodeURIComponent(website.id)}`);
  } else if (requirePublishedWebsite) {
    throw new Error(`production Phase 1 smoke account must own a published website; current status=${website.status || "unknown"}`);
  } else {
    console.warn(`[phase1-smoke] public by-id check skipped because smoke website status is ${website.status || "unknown"}; use PHASE1_REQUIRE_PUBLISHED_WEBSITE=true for the production gate.`);
  }

  await call("/auth/logout", { method: "POST" });
  console.log("Phase 1 notification/Website Studio/public projection reliability smoke: OK");
} catch (error) {
  console.error(`Phase 1 reliability smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
