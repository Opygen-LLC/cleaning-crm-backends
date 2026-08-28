import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));
const fail = (message) => {
  console.error(`PHASE5_SECURITY_FAIL: ${message}`);
  process.exitCode = 1;
};
const requireText = (file, needles) => {
  const source = read(file);
  for (const needle of needles) {
    if (!source.includes(needle)) fail(`${file} must contain ${needle}`);
  }
  return source;
};

const gitignore = read(".gitignore");
if (!/^\.env$/m.test(gitignore)) {
  fail(".gitignore must ignore .env");
}
if (!/^\.env\.local$/m.test(gitignore) || !/^\.env\.runtime$/m.test(gitignore)) {
  fail(".gitignore must ignore local/runtime environment files");
}

// Better Auth remains authoritative; Phase 5 hardens the surrounding session
// lifecycle instead of introducing a second credential store.
requireText("src/lib/auth.ts", ["betterAuth("]);
const authService = requireText("src/modules/Auth/auth.service.ts", [
  "auth.api.signInEmail",
  "auth.api.verifyEmailOTP",
  "REFRESH_TOKEN_REUSE_DETECTED",
  "FOR UPDATE OF s",
  "hashRefreshCredential",
  "refreshFamilyId",
  "previousRefreshTokenHash",
]);
if (/refreshToken\s*:\s*refreshToken\s*[,}]/.test(read("prisma/schema/auth.prisma"))) {
  fail("Prisma schema must never persist plaintext refresh tokens");
}

const schema = requireText("prisma/schema/auth.prisma", [
  "refreshTokenHash",
  "previousRefreshTokenHash",
  "refreshFamilyId",
  "refreshRotatedAt",
  "@@index([userId, expiresAt, createdAt])",
  "@@index([refreshFamilyId])",
]);
void schema;

const migration = "prisma/migrations/20260828190000_phase5_session_refresh_hardening/migration.sql";
if (!exists(migration)) fail("Phase 5 session refresh hardening migration is missing");
else requireText(migration, ["refreshTokenHash", "refreshFamilyId", "session_userId_expiresAt_createdAt_idx"]);

const sessionSecurity = requireText("src/modules/Auth/sessionSecurity.service.ts", [
  "createHash(\"sha256\")",
  "bindRefreshCredentialToSession",
  "revokeOtherSessionsForUser",
  "invalidateRuntimeSessionValidities",
]);
if (/data:\s*\{[^}]*refreshToken/i.test(sessionSecurity)) {
  fail("session security service must not store plaintext refresh tokens");
}

const token = requireText("src/lib/utils/token.ts", [
  'sameSite: "lax"',
  "httpOnly: true",
  'path: "/"',
  'tokenType: "refresh"',
  "refreshFamilyId",
  "refreshId",
]);
const accessCookieBody = token.match(/const setAccessTokenCookie[\s\S]*?^};/m)?.[0] ?? "";
if (accessCookieBody.includes("domain:")) {
  fail("canonical access cookie must remain host-only");
}

const controller = read("src/modules/Auth/auth.controller.ts");
if (/data:\s*\{\s*(accessToken|refreshToken|sessionToken|token)\s*:/m.test(controller)) {
  fail("auth controller appears to expose credentials in JSON");
}
if (!controller.includes("data: clientSafe") || !controller.includes("refreshed: true")) {
  fail("auth controller must return sanitized token-free auth payloads");
}

const routes = requireText("src/modules/Auth/auth.route.ts", [
  '"/session"',
  '"/sessions"',
  '"/sessions/revoke-others"',
  '"/sessions/:id"',
]);
void routes;

const runtimeCache = requireText("src/lib/cache/authRuntimeCache.ts", [
  'createHash("sha256")',
  "invalidateRuntimeSessionValidity",
  "invalidateRuntimeSessionValidities",
]);
if (runtimeCache.includes('return `session:${token}`')) {
  fail("Redis session-validity keys must not contain the Better Auth token in plaintext");
}

requireText("src/lib/cache/redisCircuitBreaker.ts", [
  "RedisCircuitOpenError",
  "acquireRedisCircuitPermit",
  "recordRedisCircuitFailure",
  "getRedisCircuitSnapshot",
]);
requireText("src/config/redis.ts", ["acquireRedisCircuitPermit", "RedisCircuitOpenError", "forceOpenRedisCircuit"]);

const csrf = requireText("src/middlewares/browserOriginGuard.ts", [
  "CSRF_PROTECTION_HEADER",
  "Sec-Fetch-Site",
  "CSRF_VALIDATION_FAILED",
  "getAuthenticatedOrigins",
]);
if (!csrf.includes('new Set(["POST", "PUT", "PATCH", "DELETE"])')) {
  fail("CSRF guard must cover POST/PUT/PATCH/DELETE");
}
const server = requireText("src/server.ts", ["X-CSRF-Protection", "browserOriginGuard"]);
for (const cron of ["staffStatus.cron", "recurringBooking.cron", "invoiceOverdue.cron", "dbKeepAlive.cron", "websiteAnalyticsRetention.cron"]) {
  if (server.includes(cron)) fail(`API server must not import ${cron}`);
}
if (server.includes("startEmailOutboxWorker")) fail("API server must not run outbox worker");

const userService = requireText("src/modules/User/user.service.ts", [
  "requester.role !== UserRole.SUPER_ADMIN",
  "revokeAllSessionsForUser",
  "invalidateRuntimeAuth",
]);
void userService;

const index = read("src/index.ts");
if (index.includes("seedSuperAdmin") || index.includes("seedSubscriptionPlans") || index.includes("startEmailOutboxWorker")) {
  fail("API entrypoint must not seed or run workers");
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Phase 5 backend security verification passed.");
