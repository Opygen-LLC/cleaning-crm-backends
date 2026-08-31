#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
const read = (file) => readFileSync(file, "utf8");
const failures = [];
const server = read("src/server.ts");
const routes = read("src/routes/index.ts");
const token = read("src/lib/utils/token.ts");
const runtime = read("src/config/runtimeEnv.ts");
const envExample = existsSync(".env.example") ? read(".env.example") : "";

const rootHandlers = [...server.matchAll(/app\.get\(\s*["']\/["']/g)].length;
if (rootHandlers !== 1) failures.push(`src/server.ts must contain exactly one GET / handler; found ${rootHandlers}`);
if (server.includes("Cleaning CRM Backend API 31 AUG")) failures.push("temporary timestamp service name still present");
for (const key of ["APP_VERSION", "GIT_SHA", "BUILD_DATE"]) if (!server.includes(key)) failures.push(`server metadata must include ${key}`);
if (/^import\s+\{?\s*e2eTestRoutes/m.test(routes)) failures.push("E2E router is statically imported by production routes");
if (!routes.includes('await import("../modules/E2E/e2eTest.routes")')) failures.push("non-production E2E router must be dynamically imported");
for (const old of ["opygen_access_token", "opygen_token", "COOKIE_DOMAIN"]) if (token.includes(old)) failures.push(`token utility still contains obsolete ${old}`);
for (const required of ["E2E_TEST_HOOKS_ENABLED", "forbiddenProductionKeys"]) if (!runtime.includes(required)) failures.push(`runtime production environment guard missing ${required}`);
if (/^E2E_/m.test(envExample)) failures.push("backend .env.example must not configure E2E credentials");
if (/postgresql:\/\/[^\s]*:[^\s]*@(?!(?:localhost|127\.0\.0\.1))/i.test(envExample)) failures.push(".env.example appears to contain a non-local database credential");
if (!envExample.includes("ACCESS_TOKEN_EXPIRES_IN=15m")) failures.push(".env.example must preserve 15m production access-token contract");

if (failures.length) {
  console.error("Production cleanup contract failed:\n" + failures.map((x) => ` - ${x}`).join("\n"));
  process.exit(1);
}
console.log("Production cleanup contract: OK");
