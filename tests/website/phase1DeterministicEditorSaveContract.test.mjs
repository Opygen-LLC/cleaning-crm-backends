import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("editor PUT is a revisioned configured-state acknowledgement and does not publish", () => {
  const routes = read("src/modules/Website/website.routes.ts");
  const controller = read("src/modules/Website/website.controller.ts");
  const service = read("src/modules/Website/website.service.ts");

  assert.match(routes, /router\.put\("\/editor"[\s\S]*?websiteController\.saveEditorState\)/);
  assert.match(controller, /const saveEditorState[\s\S]*?Cache-Control", "private, no-store"[\s\S]*?WebsiteService\.saveEditorState/);

  const start = service.indexOf("const saveEditorState = async");
  const end = service.indexOf("const publishWebsite = async", start);
  assert.ok(start >= 0 && end > start);
  const save = service.slice(start, end);

  assert.match(save, /assertExpectedRevision/);
  assert.match(save, /ensurePublishedSnapshotBeforeDraftMutationTx/);
  assert.match(save, /draftRevisionNumber: nextRevisionNumber/);
  assert.match(save, /presentDraftSnapshot/);
  assert.doesNotMatch(save, /publishedSnapshot:\s*buildPublishedSnapshot|publishedAt:\s*new Date/);
});

test("editor save returns the canonical full configured snapshot needed by deterministic frontend cache patching", () => {
  const service = read("src/modules/Website/website.service.ts");
  const loadStart = service.indexOf("const loadDraftSnapshot = async");
  const presentStart = service.indexOf("const presentDraftSnapshot =", loadStart);
  assert.ok(loadStart >= 0 && presentStart > loadStart);
  const load = service.slice(loadStart, presentStart);

  for (const relation of ["pages:", "domains:", "assets:", "subdomainAliases:", "primaryBookingForm:", "primaryEstimateForm:"]) {
    assert.match(load, new RegExp(relation));
  }
});
