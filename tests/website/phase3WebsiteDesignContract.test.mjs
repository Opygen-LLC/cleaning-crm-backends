import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relative) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

test("Phase 3 persists the canonical V1 website design JSON", () => {
  const prisma = read("prisma/schema/website.prisma");
  const migration = read("prisma/migrations/20260905090000_phase3_website_design_contract/migration.sql");
  const contract = read("src/modules/Website/websiteDesignContract.ts");

  assert.match(prisma, /websiteDesign\s+Json/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "websiteDesign" JSONB NOT NULL/);
  assert.match(contract, /schemaVersion:\s*z\.literal\(1\)/);
  for (const slot of ["shared", "home", "services", "about", "reviews", "contact", "booking", "estimate"]) {
    assert.match(contract, new RegExp(`${slot}:`));
  }
  assert.match(contract, /componentAnimations:/);
  assert.match(contract, /sectionStyles:/);
  assert.match(contract, /animationsEnabled:/);
});

test("configured editor state has a private server write path", () => {
  const routes = read("src/modules/Website/website.routes.ts");
  const service = read("src/modules/Website/website.service.ts");
  const start = service.indexOf("const saveEditorState");
  const end = service.indexOf("const publishWebsite", start);
  const editorSave = service.slice(start, end);

  assert.match(routes, /router\.put\("\/editor"/);
  assert.match(editorSave, /ensurePublishedSnapshotBeforeDraftMutationTx/);
  assert.match(editorSave, /draftRevisionNumber:\s*nextRevisionNumber/);
  assert.match(editorSave, /invalidateStudioAdmin/);
  assert.doesNotMatch(editorSave, /invalidatePublic|invalidateWebsiteHosts|invalidatePublished/);
});

test("public website rendering remains behind the immutable published snapshot", () => {
  const publicService = read("src/modules/Website/publicWebsite.service.ts");
  const snapshot = read("src/modules/Website/websiteSnapshot.ts");

  assert.match(publicService, /includeDraftPages:\s*false/);
  assert.match(publicService, /resolveSafePublishedSnapshot\(source\.website\)/);
  assert.match(publicService, /mode:\s*"public"/);
  assert.match(publicService, /snapshotOverride:\s*publishedSnapshot/);
  assert.match(snapshot, /websiteDesign:\s*parseWebsiteDesignContract/);
  assert.match(publicService, /design:\s*config\.websiteDesign/);
});
