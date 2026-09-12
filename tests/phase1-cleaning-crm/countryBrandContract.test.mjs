import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("registration validates and provisions country before verification", () => {
  const validation = read("src/modules/Auth/auth.validation.ts");
  const service = read("src/modules/Auth/auth.service.ts");
  const provisioning = read("src/modules/Auth/accountProvisioning.service.ts");
  assert.match(validation, /country:\s*z[\s\S]*?length\(2[\s\S]*?resolveCountryEnum/);
  assert.match(service, /provisionRegisteredAdmin\(\{[\s\S]*?country,/);
  assert.match(provisioning, /country:\s*input\.country/);
});

test("business country is a concurrency-safe set-once tenant field", () => {
  const admin = read("src/modules/Admin/admin.service.ts");
  assert.match(admin, /BUSINESS_COUNTRY_LOCKED/);
  assert.match(admin, /updateMany\(\{[\s\S]*?country:\s*null[\s\S]*?country:\s*requestedCountry/);
  assert.match(admin, /current\.country !== requestedCountry/);
});

test("country response exposes safe regional defaults without guessing multi-zone timezone", () => {
  const admin = read("src/modules/Admin/admin.service.ts");
  const defaults = read("src/lib/constants/countryRegionalDefaults.ts");
  assert.match(admin, /regionalDefaults:/);
  assert.match(defaults, /BD:\s*"Asia\/Dhaka"/);
  assert.doesNotMatch(defaults, /US:\s*"America\//);
});

test("website brand upload is R2-native and invalid finalized assets are released", () => {
  const service = read("src/modules/Website/websiteAsset.service.ts");
  assert.match(service, /provider:\s*"r2"/);
  assert.match(service, /mediaAssetId/);
  assert.match(service, /Maximum \$\{limit\.maxWidth\}x\$\{limit\.maxHeight\}px/);
  assert.match(service, /deleteAssetIfUnreferencedForTenant\(asset\.id, adminId\)/);
});
