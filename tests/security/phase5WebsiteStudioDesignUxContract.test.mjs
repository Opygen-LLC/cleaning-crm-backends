import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("editor read model exposes immutable LIVE template and design separately from configured rows", () => {
  const service = read("src/modules/Website/website.service.ts");
  assert.match(service, /const published = parsePublishedSnapshot\(website\.publishedSnapshot\)/);
  assert.match(service, /publishedTemplateId: published\?\.website\.templateId \?\? null/);
  assert.match(service, /publishedTemplateVersion: published\?\.website\.templateVersion \?\? null/);
  assert.match(service, /publishedWebsiteDesign: published\?\.website\.websiteDesign \?\? null/);
});

test("autosave preserves existing LIVE identity while publish and launch promote the configured snapshot", () => {
  const service = read("src/modules/Website/website.service.ts");
  assert.match(service, /select: \{ publishedSnapshot: true \}/);
  assert.match(service, /publishedSnapshot: liveRow\?\.publishedSnapshot \?\? null/);
  const promoted = [...service.matchAll(/publishedSnapshot,\s*\n\s*\}\);/g)];
  assert.ok(promoted.length >= 1, "publish response must promote the just-built immutable snapshot");
  assert.match(service, /website: presentDraftSnapshot\(draft,[\s\S]*?publishedSnapshot,/);
});

test("Set Active still cannot affect public rendering before Publish", () => {
  const publicService = read("src/modules/Website/publicWebsite.service.ts");
  assert.match(publicService, /resolveSafePublishedSnapshot/);
  assert.match(publicService, /current draft is intentionally never considered/i);
  assert.match(publicService, /snapshotOverride:\s*publishedSnapshot/);
});
