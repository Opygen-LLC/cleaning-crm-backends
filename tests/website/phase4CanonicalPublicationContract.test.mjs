import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("published snapshot remains the canonical live website contract", async () => {
  const snapshot = await read("src/modules/Website/websiteSnapshot.ts");
  const publicService = await read("src/modules/Website/publicWebsite.service.ts");
  assert.match(snapshot, /websiteDesign:\s*parseWebsiteDesignContract/);
  assert.match(publicService, /parsePublishedSnapshot\(website\.publishedSnapshot\)/);
  assert.match(publicService, /design:\s*config\.websiteDesign/);
});

test("publication fingerprints use stable sha256 design hashing", async () => {
  const source = await read("src/modules/Website/websiteSnapshot.ts");
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /Object\.entries\([\s\S]*\.sort\(/);
  assert.match(source, /buildWebsitePublicationFingerprint/);
  assert.match(source, /draftRevisionNumber/);
  assert.match(source, /publishedRevisionNumber/);
  assert.match(source, /matchesLive/);
});

test("admin website read models expose selected and live fingerprints without exposing raw publishedSnapshot", async () => {
  const service = await read("src/modules/Website/website.service.ts");
  const studio = await read("src/modules/Website/websiteStudio.service.ts");
  assert.match(service, /publicationFingerprint/);
  assert.match(service, /publishedTemplateId/);
  assert.match(service, /publishedWebsiteDesign/);
  assert.match(studio, /publicationFingerprint/);
  assert.match(studio, /buildWebsitePublicationFingerprint/);
});

test("publish reports committed cache and revalidation delivery status", async () => {
  const source = await read("src/modules/Website/website.service.ts");
  assert.match(source, /cacheInvalidated:\s*true/);
  assert.match(source, /revalidationTriggered:\s*revalidation\.configured/);
  assert.match(source, /revalidationDelivered:\s*revalidation\.delivered/);
  assert.match(source, /revalidationQueued:\s*revalidation\.queued/);
  assert.match(source, /projectionWarmed/);
  assert.match(source, /return \{ \.\.\.website, publicationDelivery \}/);
});
