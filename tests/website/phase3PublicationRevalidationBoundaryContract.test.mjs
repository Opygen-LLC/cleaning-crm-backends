import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("publish invalidates server caches before direct Next revalidation", async () => {
  const source = await read("src/modules/Website/website.service.ts");
  const publishStart = source.indexOf("const publishWebsite = async");
  const launchStart = source.indexOf("const REQUIRED_ONBOARDING_STEPS", publishStart);
  assert.ok(publishStart >= 0 && launchStart > publishStart);
  const publish = source.slice(publishStart, launchStart);

  const projectionIndex = publish.indexOf("WebsiteProjectionCacheService.invalidateWebsite");
  const directIndex = publish.indexOf('revalidatePublishedWebsite(website, "website-published")');
  assert.ok(projectionIndex >= 0, "Publish must invalidate the backend projection");
  assert.ok(directIndex > projectionIndex, "Direct Next revalidation must happen after server cache invalidation");
  assert.match(publish, /revalidateNext:\s*false/);
  assert.match(publish, /invalidateSubdomains\(\[/);
  assert.match(publish, /subdomainAliases\.map/);
  assert.match(publish, /invalidateHosts\(/);
  assert.match(publish, /warmPublishedProjection\(website\.id/);
});

test("direct delivery is the normal path and the outbox is fallback only", async () => {
  const source = await read("src/lib/outbox/publicWebsiteCacheOutbox.ts");
  const triggerStart = source.indexOf("const triggerWithFallback = async");
  assert.ok(triggerStart >= 0);
  const trigger = source.slice(triggerStart);

  const directIndex = trigger.indexOf("deliver(payload)");
  const enqueueIndex = trigger.indexOf("enqueue(payload)");
  assert.ok(directIndex >= 0, "Direct signed callback must be attempted");
  assert.ok(enqueueIndex > directIndex, "Outbox enqueue must only be reached after direct delivery fails");
  assert.match(source, /tenantIdentifiers\?: string\[\]/);
  assert.match(source, /NEXT_REVALIDATE_TIMEOUT_MS/);
});

test("generic public projection invalidation also uses direct revalidation unless explicitly deferred", async () => {
  const source = await read("src/modules/Website/websiteProjectionCache.service.ts");
  assert.match(source, /revalidateNext\?: boolean/);
  assert.match(source, /if \(options\.revalidateNext !== false\)/);
  assert.match(source, /PublicWebsiteCacheRevalidation\.triggerWithFallback/);
});

test("outbox worker reuses the same signed delivery implementation", async () => {
  const source = await read("src/workers/emailOutbox.worker.ts");
  assert.match(source, /PublicWebsiteCacheRevalidation\.deliver/);
  assert.match(source, /parsePublicWebsiteCacheInvalidationPayload/);
  assert.doesNotMatch(source, /fetch\(NEXT_REVALIDATE_URL/);
});
