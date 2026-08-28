import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => { console.error(`PHASE5_SECURITY_FAIL: ${message}`); process.exitCode = 1; };

const gitignore = read(".gitignore");
if (!/^\.env$/m.test(gitignore) || !/^\.env\.\*$/m.test(gitignore) || !/^!\.env\.example$/m.test(gitignore)) {
  fail(".gitignore must block .env and .env.* while allowing .env.example");
}

for (const candidate of [".env", ".env.production", ".env.runtime"]) {
  if (fs.existsSync(path.join(root, candidate))) fail(`${candidate} must not be committed/shipped as source`);
}

const controller = read("src/modules/Auth/auth.controller.ts");
if (/data:\s*\{\s*(accessToken|refreshToken|sessionToken|token)\s*:/m.test(controller)) {
  fail("auth controller appears to expose credentials in JSON");
}
if (!controller.includes("data: clientSafe") || !controller.includes("data: { refreshed: true }")) {
  fail("auth controller must return sanitized login/verification payloads and token-free refresh responses");
}

const server = read("src/server.ts");
for (const cron of ["staffStatus.cron", "recurringBooking.cron", "invoiceOverdue.cron", "dbKeepAlive.cron", "websiteAnalyticsRetention.cron"]) {
  if (server.includes(cron)) fail(`API server must not import ${cron}`);
}
if (server.includes("startEmailOutboxWorker")) fail("API server must not run outbox worker");

const index = read("src/index.ts");
if (index.includes("seedSuperAdmin") || index.includes("seedSubscriptionPlans") || index.includes("startEmailOutboxWorker")) {
  fail("API entrypoint must not seed or run workers");
}

const socket = read("src/config/socketio.ts");
if (socket.includes("sessionToken: string") || socket.includes("joinAdminRoom\", async")) {
  fail("Socket room joins must not require browser-readable session tokens");
}

const token = read("src/lib/utils/token.ts");
if (!token.includes('sameSite: "lax"') || !token.includes("httpOnly: true")) fail("auth cookies must be HttpOnly SameSite=Lax");
if (!token.includes('path: "/api/v1/auth"')) fail("refresh cookie must be restricted to auth path");

if (process.exitCode) process.exit(process.exitCode);
console.log("Phase 5 backend security verification passed.");
