import fs from "node:fs";
const required = [
  "scripts/load/phase7-load.js", "scripts/gcp/phase7-canary.sh", "scripts/phase7/evaluateReleaseGate.mjs", "scripts/phase7/checkCloudSqlSaturation.mjs", "scripts/phase7/release.sh",
  "src/modules/E2E/e2eTest.routes.ts",
];
for (const f of required) if (!fs.existsSync(f)) throw new Error(`Phase 7 missing ${f}`);
const server = fs.readFileSync("src/server.ts", "utf8");
const context = fs.readFileSync("src/middlewares/requestContext.ts", "utf8");
if (!context.includes('X-Release-Sha')) throw new Error("X-Release-Sha response header missing");
if (!server.includes('X-Release-Sha')) throw new Error("X-Release-Sha is not CORS-exposed");
const e2e = fs.readFileSync("src/modules/E2E/e2eTest.routes.ts", "utf8");
if (!e2e.includes('process.env.NODE_ENV === "production"')) throw new Error("E2E hooks lack production kill switch");
console.log("Phase 7 backend release gate: OK");
