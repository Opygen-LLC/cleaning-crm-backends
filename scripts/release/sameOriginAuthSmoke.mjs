#!/usr/bin/env node
const frontend = (process.env.FRONTEND_SMOKE_URL || "").replace(/\/+$/, "");
const email = process.env.AUTH_SMOKE_EMAIL || "";
const password = process.env.AUTH_SMOKE_PASSWORD || "";
if (!frontend || !/^https?:\/\//.test(frontend)) { console.error("FRONTEND_SMOKE_URL is required"); process.exit(2); }
if (!email || !password) { console.error("AUTH_SMOKE_EMAIL and AUTH_SMOKE_PASSWORD are required"); process.exit(2); }

const jar = new Map();
const setCookieRows = (headers) => typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
const ingest = (headers) => {
  for (const row of setCookieRows(headers)) {
    const pair = row.split(";", 1)[0]; const i = pair.indexOf("="); if (i < 1) continue;
    const key = pair.slice(0, i), value = pair.slice(i + 1); value ? jar.set(key, value) : jar.delete(key);
  }
};
const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
const call = async (path, init = {}) => {
  const method = String(init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers || {}); headers.set("Accept", "application/json"); headers.set("Origin", frontend);
  if (init.body) headers.set("Content-Type", "application/json");
  if (jar.size) headers.set("Cookie", cookie());
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-CSRF-Protection", "1");
  const response = await fetch(`${frontend}/backend-api${path}`, { ...init, method, headers, redirect: "manual" }); ingest(response.headers);
  const body = await response.json().catch(() => null); return { response, body };
};
const assertOk = (name, result) => { if (!result.response.ok) throw new Error(`${name} failed: HTTP ${result.response.status} ${result.body?.code || result.body?.message || ""}`); };

try {
  const login = await call("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); assertOk("same-origin login", login);
  if (login.body?.data?.sessionCreated !== true) throw new Error("login did not return sessionCreated=true");
  if (/accessToken|refreshToken|sessionToken|better-auth/i.test(JSON.stringify(login.body))) throw new Error("credential leaked in login JSON");
  for (const key of ["accessToken", "refreshToken", "better-auth.session_token"]) if (!jar.has(key)) throw new Error(`missing ${key} cookie through BFF`);

  const session = await call("/auth/session"); assertOk("auth/session", session);
  const snapshot = session.body?.data;
  if (snapshot?.authenticated !== true || !snapshot?.user?.role || !snapshot?.session?.expiresAt) throw new Error("canonical session snapshot incomplete");
  if (!snapshot?.onboarding || typeof snapshot.onboarding.completed !== "boolean") throw new Error("onboarding contract missing from session");

  const refresh = await call("/auth/refresh-token", { method: "POST" }); assertOk("refresh rotation", refresh);
  if (refresh.body?.data?.refreshed !== true) throw new Error("refresh contract did not confirm rotation");

  const onboardingPage = await fetch(`${frontend}/admin/onboarding`, { headers: { Cookie: cookie() }, redirect: "manual" });
  if (onboardingPage.status >= 500) throw new Error(`onboarding page smoke failed: HTTP ${onboardingPage.status}`);

  const logout = await call("/auth/logout", { method: "POST" }); assertOk("logout", logout);
  console.log("Same-origin BFF auth/session/refresh/onboarding smoke: OK");
} catch (error) {
  console.error(`Same-origin auth smoke FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exit(1);
}
