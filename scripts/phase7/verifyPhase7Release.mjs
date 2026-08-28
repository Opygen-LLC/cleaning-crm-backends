import fs from "node:fs";
const required = [
  "scripts/load/phase7-load.js",
  "scripts/gcp/phase7-canary.sh",
  "scripts/phase7/evaluateReleaseGate.mjs",
  "scripts/phase7/checkCloudSqlSaturation.mjs",
  "scripts/phase7/checkMonitoringAlerts.mjs",
  "scripts/phase7/checkSecretSafety.mjs",
  "scripts/phase7/release.sh",
  "src/modules/E2E/e2eTest.routes.ts",
  "src/lib/monitoring/alerting.ts",
  ".github/workflows/phase7-ci.yml",
];
for (const file of required) if (!fs.existsSync(file)) throw new Error(`Phase 7 missing ${file}`);
const server = fs.readFileSync("src/server.ts", "utf8");
const context = fs.readFileSync("src/middlewares/requestContext.ts", "utf8");
const logger = fs.readFileSync("src/middlewares/logger.middleware.ts", "utf8");
const perf = fs.readFileSync("src/lib/monitoring/performanceMetrics.ts", "utf8");
if (!context.includes('X-Release-Sha')) throw new Error("X-Release-Sha response header missing");
if (!server.includes('X-Release-Sha')) throw new Error("X-Release-Sha is not CORS-exposed");
if (!server.includes('/health/alerts')) throw new Error("Phase 7 alert endpoint missing");
for (const key of ["requestId", "dbDurationMs", "redisDurationMs", "externalDurationMs", "releaseSha"]) if (!logger.includes(key)) throw new Error(`Structured request log missing ${key}`);
for (const market of ["USA", "Canada", "UK", "Europe", "Australia"]) if (!perf.includes(`\"${market}\"`)) throw new Error(`Regional performance market missing: ${market}`);
const e2e = fs.readFileSync("src/modules/E2E/e2eTest.routes.ts", "utf8");
if (!e2e.includes('process.env.NODE_ENV === "production"')) throw new Error("E2E hooks lack production kill switch");
if (!e2e.includes("x-e2e-token")) throw new Error("E2E hooks lack staging token protection");
console.log("Phase 7 backend release gate: OK");
