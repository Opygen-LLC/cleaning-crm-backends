import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("online booking is a backend product invariant with default-on website state", () => {
  const access = read("src/modules/Entitlement/tenantAccessResolver.service.ts");
  const constants = read("src/modules/Website/website.constant.ts");
  const schema = read("prisma/schema/website.prisma");
  const migration = read("prisma/migrations/20260912131500_online_booking_default_on/migration.sql");
  assert.match(access, /explicit\.set\("online_booking", true\)/);
  assert.match(constants, /bookingEnabled: true/);
  assert.match(constants, /kind: "BOOK"[\s\S]*showInNavigation: true[\s\S]*isEnabled: true/);
  assert.match(schema, /bookingEnabled\s+Boolean @default\(true\)/);
  assert.match(migration, /ALTER COLUMN "bookingEnabled" SET DEFAULT true/);
});

test("registration provisions a tenant-owned published booking form without fabricated services", () => {
  const registration = read("src/modules/Auth/accountProvisioning.service.ts");
  const booking = read("src/modules/Website/websiteBookingProvisioning.service.ts");
  assert.match(registration, /provisionDefaultDraftForNewTenantTx\(tx, admin\.id\)/);
  assert.match(registration, /Default online booking provisioned/);
  assert.match(booking, /createManagedBookingForm\(tx, admin, admin\.businessWebsite, \[\]\)/);
  assert.match(booking, /ensureAtLeastOneBookableService/);
  assert.match(booking, /NO_BOOKABLE_SERVICES/);
});

test("existing-tenant reconciliation is explicit, idempotent and custom-form safe", () => {
  const booking = read("src/modules/Website/websiteBookingProvisioning.service.ts");
  const script = read("src/scripts/phase3-online-booking/reconcileOnlineBookingDefaults.ts");
  assert.match(booking, /reconcileDefaultBookingForExistingTenantTx/);
  assert.match(booking, /publishedForms\.length > 1/);
  assert.match(booking, /requiresSelection: true/);
  assert.match(booking, /if \(target\.websiteManaged\) await syncManagedFormServices/);
  assert.match(booking, /serviceCatalog:[\s\S]*adminId,[\s\S]*status: ServiceStatus\.ACTIVE,[\s\S]*onlineBookingEnabled: true/);
  assert.match(booking, /page\.kind === "BOOK" \? \{ \.\.\.page, isEnabled: true, showInNavigation: true \}/);
  assert.match(script, /process\.argv\.includes\("--fix"\)/);
  assert.match(script, /parsePublishedSnapshot\(website\.publishedSnapshot\)/);
  assert.match(script, /safelyStagedUntilServiceSetup/);
  assert.match(script, /alreadyReady/);
  assert.match(script, /choose a primary booking form in Website Studio/);
});

test("quote backend keeps draft-only editing and server-owned totals", () => {
  const quote = read("src/modules/Quote/quote.service.ts");
  assert.match(quote, /existing\.status !== QuoteStatus\.DRAFT/);
  assert.match(quote, /computeTotals/);
  assert.match(quote, /payload\.staffIds/);
  assert.match(quote, /notes: payload\.notes \?\? quote\.notes/);
});
