#!/usr/bin/env node
const apiBase = (process.env.AUTH_SMOKE_API_URL || "").replace(/\/+$/, "");
const origin = (process.env.AUTH_SMOKE_ORIGIN || "").replace(/\/+$/, "");
const email = process.env.AUTH_SMOKE_EMAIL || "";
const password = process.env.AUTH_SMOKE_PASSWORD || "";
if (!apiBase || !/^https?:\/\//.test(apiBase)) { console.error("AUTH_SMOKE_API_URL is required, e.g. https://api.example.com/api/v1"); process.exit(2); }
if (!origin || !/^https?:\/\//.test(origin)) { console.error("AUTH_SMOKE_ORIGIN is required and must match an allowed frontend origin"); process.exit(2); }
if (!email || !password) { console.error("AUTH_SMOKE_EMAIL and AUTH_SMOKE_PASSWORD are required"); process.exit(2); }

const jar = new Map();
const ingest = (headers) => {
  const rows = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  for (const row of rows) {
    const pair = row.split(";", 1)[0]; const i = pair.indexOf("="); if (i <= 0) continue;
    const key = pair.slice(0, i), value = pair.slice(i + 1); if (value) jar.set(key, value); else jar.delete(key);
  }
};
const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
const call = async (path, init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (jar.size) {
    headers.set("Cookie", cookie());
    headers.set("Origin", origin);
    if (!["GET", "HEAD", "OPTIONS"].includes(String(init.method || "GET").toUpperCase())) headers.set("X-CSRF-Protection", "1");
  }
  const response = await fetch(`${apiBase}${path}`, { ...init, headers, redirect: "manual" });
  ingest(response.headers);
  const body = await response.json().catch(() => null);
  return { response, body, requestId: response.headers.get("x-request-id"), release: response.headers.get("x-release-sha") };
};
const ok = (name, result) => {
  if (!result.response.ok) { console.error(`${name}: FAILED ${result.response.status} code=${result.body?.code || "unknown"} requestId=${result.requestId || "unknown"}`); process.exit(1); }
  console.log(`${name}: OK ${result.response.status} requestId=${result.requestId || "unknown"} release=${result.release || "unknown"}`);
};

const login = await call("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
ok("login", login);
if (/accessToken|refreshToken|sessionToken|better-auth/i.test(JSON.stringify(login.body))) { console.error("login: credential leaked in JSON body"); process.exit(1); }
for (const key of ["accessToken", "refreshToken", "better-auth.session_token"]) if (!jar.has(key)) { console.error(`login: missing ${key} cookie`); process.exit(1); }
const session = await call("/auth/session"); ok("session", session);
if (session.body?.data?.authenticated !== true || !session.body?.data?.user?.role) { console.error("session: canonical auth snapshot missing"); process.exit(1); }
const refresh = await call("/auth/refresh-token", { method: "POST" }); ok("refresh", refresh);
if (refresh.body?.data?.refreshed !== true) { console.error("refresh: contract failed"); process.exit(1); }
const logout = await call("/auth/logout", { method: "POST" }); ok("logout", logout);
console.log("Direct backend auth smoke: OK. No credentials were printed.");
