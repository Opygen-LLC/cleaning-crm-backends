import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (p) => readFileSync(join(process.cwd(), p), "utf8");

test("animation contract accepts only the canonical Phase 6 vocabulary", () => {
  const contract = read("src/modules/Website/websiteDesignContract.ts");
  for (const id of ["none","fade-in","fade-up","fade-down","fade-left","fade-right","slide-up","slide-down","slide-left","slide-right","zoom-in","zoom-out","blur-in","reveal-up"]) assert.match(contract, new RegExp(`"${id}"`));
  assert.match(contract, /animationsEnabled: z\.boolean\(\)\.default\(true\)/);
});

test("secure preview sessions are unguessable, hashed, expiring and tenant/account scoped", () => {
  const service = read("src/modules/Website/websitePreviewSession.service.ts");
  assert.match(service, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(service, /createHash\("sha256"\)/);
  assert.match(service, /TTL_SECONDS = 10 \* 60/);
  assert.match(service, /website\.adminId !== session\.adminId/);
  assert.match(service, /user\.status !== "ACTIVE"/);
});

test("preview session routes are separated into authenticated creation and public bearer consumption", () => {
  const privateRoutes = read("src/modules/Website/website.routes.ts");
  const publicRoutes = read("src/modules/Website/publicWebsite.routes.ts");
  const controller = read("src/modules/Website/website.controller.ts");
  assert.match(privateRoutes, /router\.use\(isAdmin\)/);
  assert.match(privateRoutes, /post\("\/preview-sessions"/);
  assert.match(publicRoutes, /get\("\/preview-session\/:token"/);
  assert.match(controller, /X-Robots-Tag/);
  assert.match(controller, /noindex, nofollow, noarchive/);
  assert.match(controller, /Cache-Control", "no-store/);
});

test("preview session code never publishes or invalidates public website caches", () => {
  const service = read("src/modules/Website/websitePreviewSession.service.ts");
  assert.doesNotMatch(service, /publishWebsite|publishedSnapshot\s*:|invalidate|WebsiteProjectionCache/);
  assert.match(service, /getEditorStatePreviewWebsite|getPreviewWebsite/);
});
