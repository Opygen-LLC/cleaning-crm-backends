const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("production env example contains placeholders and keeps the 15 minute access-token contract", () => {
  const env = read(".env.example");
  assert.match(env, /^DATABASE_URL=postgresql:\/\/user:password@localhost:/m);
  for (const key of [
    "BETTER_AUTH_SECRET",
    "ACCESS_TOKEN_SECRET",
    "REFRESH_TOKEN_SECRET",
    "SMTP_PASSWORD",
    "SUPER_ADMIN_PASSWORD",
    "R2_SECRET_ACCESS_KEY",
    "NEXT_REVALIDATE_SECRET",
    "PERFORMANCE_METRICS_TOKEN",
  ]) {
    assert.match(env, new RegExp(`^${key}=replace-`, "m"));
  }
  assert.match(env, /^ACCESS_TOKEN_EXPIRES_IN=15m$/m);
  assert.doesNotMatch(env, /^E2E_/m);
});

test("production auth configuration refuses access tokens longer than 15 minutes", () => {
  const source = read("src/config/authSecurity.ts");
  assert.match(source, /accessMs > 15 \* 60_000/);
  assert.match(source, /must not exceed 15m in production/);
});

test("public job review endpoints validate UUID tokens and bound JSON request bodies", () => {
  const routes = read("src/modules/Review/review.routes.ts");
  const validation = read("src/modules/Review/review.validation.ts");
  assert.match(routes, /publicJsonOnly/);
  assert.match(routes, /publicReviewBodyLimit/);
  assert.match(routes, /reviewValidation\.reviewTokenParams/);
  assert.match(validation, /Review link is invalid/);
  assert.match(validation, /Provide at least one review field to update/);
  assert.match(validation, /End date must be on or after the start date/);
});

test("review moderation and resend queries preserve source-relation tenant boundaries", () => {
  const service = read("src/modules/Review/review.service.ts");
  assert.match(service, /const reviewTenantRelationGuard = \(adminId: string\)/);
  assert.match(service, /where: \{ id, adminId, \.\.\.reviewTenantRelationGuard\(adminId\) \}/);
  assert.match(service, /where: \{ id: reviewId, adminId, \.\.\.reviewTenantRelationGuard\(adminId\) \}/);
});

test("service catalogue validates page, limit and ids, and paginates on the server", () => {
  const validation = read("src/modules/ServiceCatalog/serviceCatalog.validation.ts");
  const routes = read("src/modules/ServiceCatalog/serviceCatalog.routes.ts");
  const service = read("src/modules/ServiceCatalog/serviceCatalog.service.ts");
  const controller = read("src/modules/ServiceCatalog/serviceCatalog.controller.ts");
  assert.match(validation, /serviceCatalogFiltersSchema/);
  assert.match(validation, /page: z\.coerce\.number\(\)\.int\(\)\.min\(1\)/);
  assert.match(validation, /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)/);
  assert.match(validation, /serviceCatalogIdParamsSchema/);
  assert.match(routes, /serviceCatalogValidation\.serviceCatalogFilters/);
  assert.match(routes, /serviceCatalogValidation\.serviceCatalogIdParams/g);
  assert.match(service, /filtered\.slice\(start, start \+ limit\)/);
  assert.match(service, /meta: \{ page, limit, total, totalPages, stats \}/);
  assert.match(controller, /data: result\.data/);
  assert.match(controller, /meta: result\.meta/);
});

test("billing history pagination is validated before reaching the subscription service", () => {
  const routes = read("src/modules/Subscription/subscription.routes.ts");
  const validation = read("src/modules/Subscription/subscription.validation.ts");
  assert.match(validation, /billingHistoryQuerySchema/);
  assert.match(routes, /subscriptionValidation\.billingHistoryQuerySchema/);
});

test("application logging redacts credential-bearing metadata and strings", () => {
  const logger = read("src/lib/logger.ts");
  assert.match(logger, /\[REDACTED\]/);
  assert.match(logger, /authorization\|cookie\|set-cookie/);
  assert.match(logger, /Bearer\\s\+/);
  assert.match(logger, /postgres\(\?:ql\)\?/);
  assert.match(logger, /redactSensitiveFormat/);
});


test("secret safety checks commented assignments and keeps sanitized env examples committable", () => {
  const source = read("scripts/phase7/checkSecretSafety.mjs");
  const gitignore = read(".gitignore");
  assert.ok(source.includes(String.raw`^(?:#\\s*)?`));
  assert.match(source, /NEXT_REVALIDATE_SECRET/);
  assert.match(source, /R2_SECRET_ACCESS_KEY/);
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
});

test("tenant hard-delete waits for every independent R2 purge before deciding success or retry", () => {
  const source = read("src/modules/SuperAdmin/tenantAdmin.service.ts");
  assert.match(source, /Promise\.allSettled\(\[/);
  assert.match(source, /publicResult/);
  assert.match(source, /privateResult/);
  assert.match(source, /temporaryResult/);
});

test("website publication production gate matches durable delivery architecture", () => {
  const gate = read("scripts/phase8/verifyProductionRollout.mjs");
  const contract = read("tests/security/phase8ProductionRolloutContract.test.mjs");
  assert.match(gate, /WebsitePublicationDeliveryService\\\.attemptImmediate|WebsitePublicationDeliveryService\.attemptImmediate/);
  assert.match(contract, /WebsitePublicationDeliveryService\\\.attemptImmediate|WebsitePublicationDeliveryService\.attemptImmediate/);
  assert.match(gate, /websitePublicationDelivery\.service/);
});


test("public website reviews obey the same effective reviews entitlement and exclude archived services", () => {
  const source = read("src/modules/Website/publicWebsite.service.ts");
  assert.match(source, /access\.effectiveEntitlements\.reviews/);
  assert.match(source, /WEBSITE_REVIEWS_UNAVAILABLE/);
  assert.match(source, /where: \{ status: ServiceStatus\.ACTIVE, archivedAt: null \}/);
  assert.match(source, /status: ServiceStatus\.ACTIVE,[\s\S]*archivedAt: null/);
});

test("Phase 4 introduces no schema mutation and retains the Phase 3 forward migration", () => {
  const migrations = fs.readdirSync(path.join(root, "prisma/migrations"));
  assert.ok(migrations.includes("20260911190500_phase3_service_catalog_archiving"));
  assert.equal(migrations.filter((name) => /phase4.*cleaning/i.test(name)).length, 0);
});
