#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
const read = (file) => readFileSync(file, "utf8");
const failures = [];
const server = read("src/server.ts");
const routes = read("src/routes/index.ts");
const token = read("src/lib/utils/token.ts");
const runtime = read("src/config/runtimeEnv.ts");
const envExample = existsSync(".env.example") ? read(".env.example") : "";
const websiteRoutes = read("src/modules/Website/website.routes.ts");
const publicWebsiteRoutes = read("src/modules/Website/publicWebsite.routes.ts");
const websiteController = read("src/modules/Website/website.controller.ts");
const emailRuntime = read("src/lib/email.ts");
const userRoutes = read("src/modules/User/user.routes.ts");

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

if (existsSync("src/modules/Session/session.routes.ts")) failures.push("legacy /session/my-session route module must be deleted");
if (websiteRoutes.includes('"/draft"') || websiteController.includes("saveDraft")) failures.push("database Website Save Draft surface must be removed");
if (websiteRoutes.includes('"/analytics"') || publicWebsiteRoutes.includes('"/:identifier/analytics"')) failures.push("obsolete first-party visitor analytics routes must be removed");
for (const alias of ["staff-job-dispatch", "quote-send", "invoice-send", '"reminder-24h"']) {
  if (emailRuntime.includes(alias)) failures.push(`legacy notification template alias remains in runtime: ${alias}`);
}
if (!userRoutes.includes('"/me/avatar"')) failures.push("canonical POST /user/me/avatar route is missing");
const genericUserPatchMatch = /router\.patch\(\s*"\/:id"/.exec(userRoutes);
if (genericUserPatchMatch) {
  const genericUserPatchStart = genericUserPatchMatch.index;
  const genericUserPatchEnd = userRoutes.indexOf("\n);", genericUserPatchStart);
  const genericUserPatchBlock = userRoutes.slice(
    genericUserPatchStart,
    genericUserPatchEnd >= 0 ? genericUserPatchEnd + 3 : genericUserPatchStart + 800,
  );
  if (genericUserPatchBlock.includes("multerMemory")) failures.push("legacy generic PATCH /user/:id must not accept multipart avatar uploads");
}

if (failures.length) {
  console.error("Production cleanup contract failed:\n" + failures.map((x) => ` - ${x}`).join("\n"));
  process.exit(1);
}
console.log("Production cleanup contract: OK");
