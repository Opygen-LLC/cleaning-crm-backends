import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

test("country rollout uses a real migration and never guesses missing tenant country", () => {
  const schema = read("prisma/schema/admin.prisma");
  const migration = read("prisma/migrations/20260912143000_country_lock_rollout/migration.sql");
  const service = read("src/modules/Admin/admin.service.ts");
  const reconcile = read("src/scripts/phase4-cleaning-crm/reconcileCountryLocks.ts");

  assert.match(schema, /countryLockedAt\s+DateTime\?/);
  assert.match(schema, /countrySelectionRequiredAt\s+DateTime\?/);
  assert.match(migration, /WHERE "country" IS NOT NULL/);
  assert.match(migration, /WHERE "country" IS NULL/);
  assert.doesNotMatch(migration, /UPDATE[\s\S]*SET "country"\s*=/i);
  assert.match(service, /countrySetupRequired: profileFields\.country === null/);
  assert.match(service, /where: \{ id: adminId, country: null \}/);
  assert.match(service, /countryLockedAt: new Date\(\)/);
  assert.match(service, /countrySelectionRequiredAt: null/);
  assert.match(reconcile, /Missing country remains missing/);
  assert.match(reconcile, /missing country is never inferred/);
});

test("lead reference search and follow-up direct-object reads stay tenant scoped", () => {
  const constants = read("src/modules/Lead/lead.constant.ts");
  const leadService = read("src/modules/Lead/lead.service.ts");
  const activity = read("src/modules/Lead/leadActivity.service.ts");

  assert.match(constants, /"leadRef"/);
  assert.match(leadService, /where: \{ id, adminId \}/);
  assert.match(activity, /where: \{ id: leadId, adminId \}/);
  assert.match(activity, /where: \{ id: activityId, leadId, adminId \}/);
  assert.match(activity, /where: Prisma\.LeadActivityWhereInput = \{[\s\S]*adminId,[\s\S]*type: "FOLLOW_UP"/);
});

test("online-booking backfill remains explicit, idempotent and safe for custom forms", () => {
  const service = read("src/modules/Website/websiteBookingProvisioning.service.ts");
  const script = read("src/scripts/phase3-online-booking/reconcileOnlineBookingDefaults.ts");

  assert.match(service, /acquireExtendedTextTransactionAdvisoryLock\(tx, `website-booking-provision:\$\{adminId\}`\)/);
  assert.match(service, /publishedForms\.length > 1/);
  assert.match(service, /requiresSelection: true/);
  assert.match(service, /if \(target\.websiteManaged\) await syncManagedFormServices/);
  assert.match(service, /where: \{ adminId, websiteManaged: true \}/);
  assert.match(script, /alreadyReady/);
  assert.match(script, /safelyStagedUntilServiceSetup/);
  assert.match(script, /mode: applyFixes \? "fix" : "dry-run"/);
  assert.match(script, /criticalUnresolved/);
});

test("production release path uses migrations and never prisma db push", () => {
  const pkg = JSON.parse(read("package.json"));
  const scripts = Object.values(pkg.scripts ?? {}).join("\n");
  assert.doesNotMatch(scripts, /prisma\s+db\s+push/);
  assert.match(pkg.scripts["db:migrate:deploy"], /prisma migrate deploy/);
  assert.match(pkg.scripts["country-locks:report"], /reconcileCountryLocks\.ts/);
  assert.match(pkg.scripts["country-locks:fix"], /--fix/);
});

test("Phase 4 rollout orders migration, backend, idempotent backfills, frontend, and smoke safely", () => {
  const rollout = read("scripts/release/phase4CleaningCrmRollout.sh");
  const pkg = JSON.parse(read("package.json"));

  assert.match(rollout, /PRODUCTION_BACKUP_CMD/);
  assert.match(rollout, /db:migrate:deploy/);
  assert.match(rollout, /BACKEND_DEPLOY_CMD/);
  assert.match(rollout, /phase4:backfill:fix/);
  assert.match(rollout, /phase4:backfill:verify/);
  assert.match(rollout, /FRONTEND_DEPLOY_CMD/);
  assert.match(rollout, /test:e2e:phase4:cleaning-crm/);
  assert.match(rollout, /migrations\/backfills are forward-only/i);
  assert.match(pkg.scripts["phase4:backfill:report"], /country-locks:report/);
  assert.match(pkg.scripts["phase4:backfill:fix"], /online-booking:defaults:fix/);
  assert.match(pkg.scripts["phase4:backfill:verify"], /online-booking:defaults:verify/);
});

test("country verification fails CI while lock-marker repairs remain but permits intentional user country selection", () => {
  const reconcile = read("src/scripts/phase4-cleaning-crm/reconcileCountryLocks.ts");
  assert.match(reconcile, /ci\s*\? summary\.markerRepairsNeeded/);
  assert.doesNotMatch(reconcile, /criticalUnresolved[^\n]*needsUserCountrySelection/);
});
