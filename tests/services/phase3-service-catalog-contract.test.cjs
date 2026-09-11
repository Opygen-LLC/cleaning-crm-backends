const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("recommended catalogue contains the nine requested cleaning services and no fabricated prices", () => {
  const source = read("src/modules/ServiceCatalog/recommendedCleaningServices.ts");
  for (const name of [
    "Regular Cleaning",
    "Deep Cleaning",
    "Move-In/Move-Out Cleaning",
    "Office/Commercial Cleaning",
    "Airbnb/Short-Term Rental Cleaning",
    "Post-Construction Cleaning",
    "Window Cleaning",
    "Carpet/Upholstery Cleaning",
    "One-Time/Spring Cleaning",
  ]) {
    assert.match(source, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const catalogue = source.split("interface ExistingRecommendedCandidate")[0];
  assert.equal((catalogue.match(/basePrice:\s*0,/g) || []).length, 9);
  assert.equal((catalogue.match(/status:\s*ServiceStatus\.INACTIVE,/g) || []).length, 9);
  assert.equal((catalogue.match(/onlineBookingEnabled:\s*false,/g) || []).length, 9);
});

test("all supported new-admin provisioning paths seed the starter catalogue inside their transaction", () => {
  const registration = read("src/modules/Auth/accountProvisioning.service.ts");
  const superAdmin = read("src/modules/SuperAdmin/superAdmin.service.ts");
  assert.match(registration, /prisma\.\$transaction\(/);
  assert.match(registration, /provisionDefaultWebsiteForAdminTx[\s\S]*?seedRecommendedCleaningServicesTx\(tx, admin\.id\)/);
  assert.match(superAdmin, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(superAdmin, /provisionDefaultWebsiteForAdminTx[\s\S]*?seedRecommendedCleaningServicesTx\(tx, admin\.id\)/);
});

test("recommended import is tenant-scoped, advisory-locked, idempotent, and restores archived presets", () => {
  const source = read("src/modules/ServiceCatalog/recommendedCleaningServices.ts");
  assert.match(source, /lockServiceCatalogTx\(tx, adminId\)/);
  assert.match(source, /where:\s*\{\s*adminId\s*\}/);
  assert.match(source, /candidate\.archivedAt/);
  assert.match(source, /archivedAt:\s*null/);
  assert.match(source, /status:\s*ServiceStatus\.INACTIVE/);
  assert.match(source, /onlineBookingEnabled:\s*false/);
});

test("literal recommended routes are admin-only and declared before the dynamic id route", () => {
  const source = read("src/modules/ServiceCatalog/serviceCatalog.routes.ts");
  const getRecommended = source.indexOf('"/recommended"');
  const importRecommended = source.indexOf('"/recommended/import"');
  const dynamicId = source.indexOf('"/:id"');
  assert.ok(getRecommended > -1 && importRecommended > -1 && dynamicId > -1);
  assert.ok(getRecommended < dynamicId);
  assert.ok(importRecommended < dynamicId);
  assert.match(source, /"\/recommended"[\s\S]*?checkAuth\(UserRole\.ADMIN\)/);
  assert.match(source, /"\/recommended\/import"[\s\S]*?checkAuth\(UserRole\.ADMIN\)/);
});


test("website booking never fabricates a priced service for an unconfigured starter catalogue", () => {
  const source = read("src/modules/Website/websiteBookingProvisioning.service.ts");
  assert.doesNotMatch(source, /basePrice:\s*60/);
  assert.doesNotMatch(source, /const serviceName = "Standard Cleaning"/);
  assert.match(source, /NO_BOOKABLE_SERVICES/);
  assert.match(source, /archivedAt:\s*null/);
  assert.match(source, /Set a real price, activate the service, and turn on Online booking first/);
});

test("zero-price services cannot be activated while inactive presets remain valid setup records", () => {
  const source = read("src/modules/ServiceCatalog/serviceCatalog.service.ts");
  assert.match(source, /SERVICE_PRICE_REQUIRED_FOR_ACTIVATION/);
  assert.match(source, /basePrice > 0/);
  assert.match(source, /payload\.status \?\? ServiceStatus\.ACTIVE/);
  assert.match(source, /assertActivationReady\(payload\.basePrice, intendedStatus\)/);
});

test("referenced services are archived and unreferenced services may be hard deleted", () => {
  const source = read("src/modules/ServiceCatalog/serviceCatalog.service.ts");
  for (const relation of [
    "invoices", "estimates", "quotes", "quoteTemplates", "bookingFormServices",
    "bookingFormSubmissions", "estimateFormServices", "estimateFormSubmissions",
    "bookings", "jobs", "recurringSchedules", "checklistTemplates", "leads",
    "websiteSubmissions", "reviews",
  ]) {
    assert.match(source, new RegExp(`${relation}:\\s*true`));
  }
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /historicalReferences === 0[\s\S]*?serviceCatalog\.delete/);
  assert.match(source, /mode:\s*"ARCHIVED"/);
  assert.match(source, /archivedAt:\s*new Date\(\)/);
  assert.match(source, /onlineBookingEnabled:\s*false/);
});

test("archived services are excluded from current catalogue and onboarding read models", () => {
  const service = read("src/modules/ServiceCatalog/serviceCatalog.service.ts");
  const onboarding = read("src/modules/ServiceCatalog/serviceCatalogConcurrency.ts");
  assert.match(service, /where:\s*\{\s*adminId,\s*archivedAt:\s*null\s*\}/);
  assert.match(onboarding, /where:\s*\{\s*adminId,\s*archivedAt:\s*null\s*\}/);
});

test("database schema and forward migration support history-safe service archiving", () => {
  const schema = read("prisma/schema/service.prisma");
  const migration = read("prisma/migrations/20260911190500_phase3_service_catalog_archiving/migration.sql");
  assert.match(schema, /archivedAt\s+DateTime\?/);
  assert.match(schema, /@@index\(\[adminId, archivedAt, status\]\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /service_catalog_adminId_archivedAt_status_idx/);
});
