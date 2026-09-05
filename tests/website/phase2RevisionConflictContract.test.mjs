import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("draft optimistic-lock conflicts do not invalidate any public website cache", () => {
  const service = read("src/modules/Website/website.service.ts");
  const start = service.indexOf("const assertExpectedRevision = async");
  const end = service.indexOf("const assertLifecycleAllowsDraftMutation", start);
  assert.ok(start >= 0 && end > start);
  const guard = service.slice(start, end);

  assert.match(guard, /throw new WebsiteDraftConflictError\(expectedRevisionNumber, currentRevisionNumber\)/);
  assert.doesNotMatch(guard, /invalidateWebsite|invalidatePublic|publicWebsiteCache|outbox|revalidat/i);
});

test("draft conflict carries both browser and server revision numbers", () => {
  const service = read("src/modules/Website/website.service.ts");
  const controller = read("src/modules/Website/website.controller.ts");

  assert.match(service, /export class WebsiteDraftConflictError extends AppError/);
  assert.match(service, /expectedRevisionNumber: number/);
  assert.match(service, /currentRevisionNumber: number/);
  assert.match(service, /code: "WEBSITE_DRAFT_CONFLICT"/);
  assert.match(service, /retryable: false/);

  assert.match(controller, /code: "WEBSITE_DRAFT_CONFLICT"/);
  assert.match(controller, /expectedRevisionNumber: error\.expectedRevisionNumber/);
  assert.match(controller, /currentRevisionNumber: error\.currentRevisionNumber/);
  assert.match(controller, /res\.status\(status\.CONFLICT\)\.json/);
});

test("all revision-sensitive Website Studio mutations return the rich conflict contract", () => {
  const controller = read("src/modules/Website/website.controller.ts");
  const boundaries = [
    ["saveEditorState", "publishWebsite"],
    ["publishWebsite", "launchWebsite"],
    ["launchWebsite", "getWebsiteBookingSetup"],
    ["restoreRevision", "listAssets"],
  ];
  for (const [name, nextName] of boundaries) {
    const start = controller.indexOf(`const ${name} = catchAsync`);
    const end = controller.indexOf(`const ${nextName} =`, start);
    assert.ok(start >= 0 && end > start, `${name} controller missing`);
    const block = controller.slice(start, end);
    assert.match(block, /WebsiteDraftConflictError/);
    assert.match(block, /sendWebsiteDraftConflict/);
  }
});

test("configured autosave still changes only draft state while publish remains the live boundary", () => {
  const service = read("src/modules/Website/website.service.ts");
  const saveStart = service.indexOf("const saveEditorState = async");
  const publishStart = service.indexOf("const publishWebsite = async", saveStart);
  const launchStart = service.indexOf("const launchWebsite = async", publishStart);
  assert.ok(saveStart >= 0 && publishStart > saveStart && launchStart > publishStart);

  const save = service.slice(saveStart, publishStart);
  const publish = service.slice(publishStart, launchStart);
  assert.match(save, /draftRevisionNumber: nextRevisionNumber/);
  assert.doesNotMatch(save, /publishedSnapshot:\s*buildPublishedSnapshot|publishedAt:\s*new Date/);
  assert.match(publish, /buildPublishedSnapshot|publishedSnapshot/);
});
