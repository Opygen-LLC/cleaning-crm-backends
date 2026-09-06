import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

const migration = read("prisma/migrations/20260905153000_phase8_website_design_rollout_guard/migration.sql");
assert.match(migration, /componentOverrides/);
assert.match(migration, /componentAnimations/);
assert.match(migration, /sectionStyles/);
assert.match(migration, /animationsEnabled/);
assert.match(migration, /THEN website\."websiteDesign"/);
assert.match(migration, /array_replace[\s\S]*'template'[\s\S]*'review_launch'/);

const provisioning = read("src/modules/Website/websiteProvisioning.service.ts");
assert.match(provisioning, /payload\.templateId \?\? DEFAULT_WEBSITE_SETTINGS\.templateId/);
assert.match(provisioning, /revisionNumber:\s*1/);

const auth = read("src/modules/Auth/auth.service.ts");
assert.match(auth, /requireEmailOtpVerification \?\? true/);
assert.match(auth, /requireEmailVerification:\s*verificationRequired/);
assert.match(auth, /verificationRequired:\s*false/);

const adminSteps = read("src/modules/Admin/admin.constant.ts");
assert.match(adminSteps, /Review \+ Launch/);
assert.doesNotMatch(adminSteps, /label:\s*["']Template/);

const service = read("src/modules/Website/website.service.ts");
const saveStart = service.indexOf("const saveEditorState = async");
const publishStart = service.indexOf("const publishWebsite = async");
const launchStart = service.indexOf("const launchWebsite = async");
const save = service.slice(saveStart, publishStart);
const publish = service.slice(publishStart, launchStart);
assert.match(save, /invalidateStudioAdmin/);
assert.doesNotMatch(save, /invalidateWebsite\(/);
assert.doesNotMatch(save, /invalidateHosts\(/);
assert.doesNotMatch(save, /invalidateSubdomains\(/);
assert.match(publish, /publishedSnapshot/);
assert.match(publish, /enqueuePublicationTx\(tx/);
assert.match(publish, /deliverImmediate/);
const delivery = read("src/modules/Website/websitePublicationDelivery.service.ts");
assert.match(delivery, /await TenantAccessResolver\.invalidate/);
assert.match(delivery, /invalidateWebsite\(/);
assert.match(delivery, /invalidateHosts\(/);
assert.match(delivery, /invalidateSubdomains\(/);
assert.ok(delivery.indexOf("await TenantAccessResolver.invalidate") < delivery.indexOf("invalidateSubdomains("));

console.log("Phase 8 production rollout source gate passed.");
