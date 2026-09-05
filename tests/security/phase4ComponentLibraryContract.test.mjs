import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("public website projection carries the live premium-component entitlement", () => {
  const source = read("src/modules/Website/publicWebsite.service.ts");
  assert.match(source, /componentEntitlements:\s*\{/);
  assert.match(source, /premiumTemplates:\s*entitlements\.premiumTemplates/);
});

test("Phase 4 keeps the immutable published snapshot boundary intact", () => {
  const source = read("src/modules/Website/publicWebsite.service.ts");
  assert.match(source, /resolveSafePublishedSnapshot/);
  assert.match(source, /current draft is intentionally never considered/i);
  assert.match(source, /snapshotOverride:\s*publishedSnapshot/);
});
