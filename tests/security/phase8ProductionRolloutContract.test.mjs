import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (p) => readFileSync(join(process.cwd(), p), "utf8");

test("existing websites migrate to the complete V1 design shape without erasing configured overrides", () => {
  const migration = read("prisma/migrations/20260905153000_phase8_website_design_rollout_guard/migration.sql");
  assert.match(migration, /defaults\.value \|\|/);
  assert.match(migration, /THEN website\."websiteDesign"/);
  for (const key of ["schemaVersion", "componentOverrides", "componentAnimations", "sectionStyles", "animationsEnabled"]) {
    assert.match(migration, new RegExp(key));
  }
  assert.doesNotMatch(migration, /SET\s+"templateId"/i);
});

test("registration stays fail-closed for OTP and provisions the default website before onboarding", () => {
  const auth = read("src/modules/Auth/auth.service.ts");
  const provisioning = read("src/modules/Website/websiteProvisioning.service.ts");
  const constants = read("src/modules/Website/website.constant.ts");
  const steps = read("src/modules/Admin/admin.constant.ts");
  assert.match(auth, /requireEmailOtpVerification \?\? true/);
  assert.match(auth, /requireEmailVerification:\s*verificationRequired/);
  assert.match(provisioning, /DEFAULT_WEBSITE_SETTINGS\.templateId/);
  assert.match(provisioning, /revisionNumber:\s*1/);
  assert.match(constants, /templateId:\s*["']clean-modern["']/);
  assert.match(steps, /Review \+ Launch/);
  assert.doesNotMatch(steps, /label:\s*["']Template/);
});

test("Super Admin OTP policy remains role-protected, audited and new-registration-only", () => {
  const routes = read("src/modules/SuperAdmin/superAdmin.routes.ts");
  const controller = read("src/modules/SuperAdmin/superAdmin.controller.ts");
  const config = read("src/lib/utils/platformConfig.ts");
  assert.match(routes, /"\/platform-config"[\s\S]*isSuperAdmin[\s\S]*updatePlatformConfig/);
  assert.match(controller, /PLATFORM_AUTH_SETTING_UPDATED/);
  assert.match(controller, /NEW_REGISTRATIONS_ONLY/);
  assert.match(controller, /before:\s*\{ requireEmailOtpVerification:/);
  assert.match(controller, /after:\s*\{ requireEmailOtpVerification:/);
  assert.match(config, /return typeof candidate === "boolean" \? candidate : true/);
  assert.match(config, /cachedConfig = updated/);
});

test("Set Active, component changes and animations remain editor-only; Publish is the sole public-cache boundary", () => {
  const service = read("src/modules/Website/website.service.ts");
  const saveStart = service.indexOf("const saveEditorState = async");
  const publishStart = service.indexOf("const publishWebsite = async");
  const launchStart = service.indexOf("const launchWebsite = async");
  const save = service.slice(saveStart, publishStart);
  const publish = service.slice(publishStart, launchStart);
  assert.match(save, /ensurePublishedSnapshotBeforeDraftMutationTx/);
  assert.match(save, /invalidateStudioAdmin/);
  assert.doesNotMatch(save, /invalidateWebsite\(|invalidateHosts\(|invalidateSubdomains\(/);
  assert.match(publish, /assertWebsiteDesignPublishable/);
  assert.ok(publish.indexOf("assertWebsiteDesignPublishable") < publish.indexOf("buildPublishedSnapshot"));
  assert.match(publish, /publishedSnapshot/);
  // Publication now persists a durable delivery event inside the transaction,
  // then attempts that exact event immediately. Cache invalidation lives in the
  // shared delivery service so retries and the outbox worker execute identical
  // ordering rather than maintaining a second publish-only invalidation path.
  assert.match(publish, /enqueuePublicationTx\(/);
  assert.match(publish, /WebsitePublicationDeliveryService\.attemptImmediate/);
  const delivery = read("src/modules/Website/websitePublicationDelivery.service.ts");
  assert.match(delivery, /await TenantAccessResolver\.invalidate/);
  assert.match(delivery, /invalidateWebsite\(/);
  assert.match(delivery, /invalidateHosts\(/);
  assert.match(delivery, /invalidateSubdomains\(/);
  assert.ok(delivery.indexOf("await TenantAccessResolver.invalidate") < delivery.indexOf("invalidateSubdomains("));
});

test("the release gate makes Phase 8 regression protection mandatory in CI", () => {
  const pkg = JSON.parse(read("package.json"));
  const workflow = read(".github/workflows/phase7-ci.yml");
  assert.match(pkg.scripts["release:check"], /check:phase8:production/);
  assert.match(pkg.scripts["check:phase8:production"], /phase8ProductionRolloutContract/);
  assert.match(workflow, /check:phase8:production/);
});
