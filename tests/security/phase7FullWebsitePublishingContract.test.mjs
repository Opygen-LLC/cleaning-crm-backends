import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (p) => readFileSync(join(process.cwd(), p), "utf8");

test("Publish and Launch strictly validate stored design/component entitlements before immutable snapshot creation", () => {
  const service = read("src/modules/Website/website.service.ts");
  const publishStart = service.indexOf("const publishWebsite = async");
  const launchStart = service.indexOf("const launchWebsite = async");
  const restoreStart = service.indexOf("const restoreRevision = async");
  const publish = service.slice(publishStart, launchStart);
  const launch = service.slice(launchStart, restoreStart);
  for (const block of [publish, launch]) {
    assert.match(block, /assertWebsiteDesignPublishable\(draft\.websiteDesign, entitlements\)/);
    assert.ok(block.indexOf("assertWebsiteDesignPublishable") < block.indexOf("buildPublishedSnapshot"));
    assert.ok(block.indexOf("assertWebsiteDesignPublishable") < block.indexOf("createRevisionSnapshotTx"));
  }
  const registry = read("src/modules/Website/websiteComponentRegistry.ts");
  assert.match(registry, /websiteDesignContractSchema\.safeParse\(value\)/);
  assert.match(registry, /WEBSITE_DESIGN_INVALID/);
  assert.match(registry, /WEBSITE_COMPONENT_UNKNOWN/);
  assert.match(registry, /WEBSITE_COMPONENT_SLOT_MISMATCH/);
  assert.match(registry, /WEBSITE_PREMIUM_COMPONENT_REQUIRED/);
});

test("the canonical backend slot registry covers homepage and every Phase 7 public-page slot", () => {
  const registry = read("src/modules/Website/websiteComponentRegistry.ts");
  for (const slot of [
    "shared.header","shared.footer","home.hero","home.trustStats","home.services","home.howItWorks","home.whyChooseUs","home.reviews","home.serviceAreas","home.cta",
    "services.hero","services.listing","services.card","services.cta",
    "about.hero","about.story","about.values","about.statistics","about.cta",
    "reviews.hero","reviews.summary","reviews.listing","reviews.card","reviews.cta",
    "contact.hero","contact.businessInfo","contact.form","contact.map",
    "booking.hero","booking.formWrapper","estimate.hero","estimate.formWrapper",
  ]) assert.match(registry, new RegExp(`"${slot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
});

test("public website projection keeps services and reviews canonical and published-only", () => {
  const publicService = read("src/modules/Website/publicWebsite.service.ts");
  assert.match(publicService, /status: "published"/);
  assert.match(publicService, /staffId: null/);
  assert.match(publicService, /review\.aggregate/);
  assert.match(publicService, /projectCanonicalService/);
  assert.match(publicService, /includeDraftPages: false/);
  assert.match(publicService, /publishedSnapshot/);
});

test("revision snapshots include design, branding, forms/presentation and SEO while restore remains editor-only", () => {
  const service = read("src/modules/Website/website.service.ts");
  const snapshotStart = service.indexOf("const loadDraftSnapshot");
  const snapshotEnd = service.indexOf("type DraftSnapshot", snapshotStart);
  const snapshot = service.slice(snapshotStart, snapshotEnd);
  for (const field of [
    "websiteDesign","primaryColor","secondaryColor","accentColor","font","logo","favicon",
    "primaryBookingFormId","bookingEnabled","bookingShowNavigation","bookingShowHeaderCta","bookingShowServiceCtas","bookingShowHomeCta","bookingShowPrices","bookingCtaLabel",
    "primaryEstimateFormId","estimateEnabled","metaTitle","metaDescription","metaKeywords","socialImageUrl","indexSite","pages",
  ]) assert.match(snapshot, new RegExp(`\\b${field}\\b`));

  const restoreStart = service.indexOf("const restoreRevision = async");
  const restoreEnd = service.indexOf("const attachManagedBrandAsset", restoreStart);
  const restore = service.slice(restoreStart, restoreEnd);
  assert.match(restore, /Restore is intentionally a draft-only operation/);
  assert.match(restore, /ensurePublishedSnapshotBeforeDraftMutationTx/);
  assert.match(restore, /Draft preserved before restoring revision/);
  assert.match(restore, /preservedRevision\.revisionNumber/);
  assert.match(restore, /invalidateStudioAdmin/);
  assert.doesNotMatch(restore, /invalidateWebsite\(|invalidateHosts\(|invalidateSubdomains\(/);
  assert.doesNotMatch(restore, /publishedSnapshot:\s*toInputJsonValue/);
});
