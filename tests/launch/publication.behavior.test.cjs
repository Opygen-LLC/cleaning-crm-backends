const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/launch-fixture.cjs');

test('regression 1: cached DRAFT -> launch -> first canonical host serves the committed site/revision', async () => {
  const f = fixture();
  assert.equal((await f.access.resolve(f.adminId)).website.status, 'DRAFT');
  assert.equal((await f.host.resolveHost('cleaning-test.sites.example.com')).availability, 'unpublished');
  const result = await f.launch();
  const route = await f.host.resolveHost('cleaning-test.sites.example.com');
  const projection = await f.publicWebsite.getPublicWebsiteById(route.websiteId);
  assert.equal(route.websiteId, result.website.id);
  assert.equal(route.availability, 'live');
  assert.equal(projection.website.publishedRevisionNumber, result.website.publishedRevisionNumber);
  assert.equal(result.publicationDelivery.ready, true);
  assert.ok(f.state().owner.onboardingCompletedSteps.includes('review_launch'));
});

test('regression 3: simultaneous double-clicks, stale expected revision and later retries create one publication', async () => {
  const f = fixture();
  // Legacy separately-completed review remains compatible.
  f.state().owner.onboardingCompletedSteps.push('review_launch');
  const [first, second] = await Promise.all([f.launch({ expectedRevisionNumber: 5 }), f.launch({ expectedRevisionNumber: 5 })]);
  const third = await f.launch({ expectedRevisionNumber: 5 });
  assert.equal(first.website.id, second.website.id);
  assert.equal(third.website.publishedRevisionNumber, 6);
  assert.equal(f.state().revisions.length, 1);
  assert.equal(f.controls.bookingCalls, 1);
  assert.equal(f.state().events.size, 1);
  assert.equal(second.alreadyLive, true);
});

test('regression 4: post-COMMIT timeout is safely retried with the original expected revision', async () => {
  const f = fixture();
  f.state().owner.onboardingCompletedSteps.push('review_launch');
  f.controls.failImmediate = true;
  await assert.rejects(f.launch({ expectedRevisionNumber: 5 }), /timeout after COMMIT/);
  assert.equal(f.state().website.publishedRevisionNumber, 6);
  assert.equal(f.state().events.size, 1);
  f.controls.failImmediate = false;
  const retry = await f.launch({ expectedRevisionNumber: 5 });
  assert.equal(retry.alreadyLive, true);
  assert.equal(retry.publicationDelivery.ready, true);
  assert.equal(f.state().revisions.length, 1);
});

test('durable outbox insert failure rolls back snapshot, review milestone and onboarding completion', async () => {
  const f = fixture(); f.controls.failEnqueue = true;
  await assert.rejects(f.launch(), /outbox insert failed/);
  assert.equal(f.state().website.status, 'DRAFT');
  assert.equal(f.state().website.publishedSnapshot, null);
  assert.equal(f.state().owner.onboardingCompletedAt, null);
  assert.equal(f.state().owner.onboardingCompletedSteps.includes('review_launch'), false);
  assert.equal(f.state().revisions.length, 0);
});

test('a failed warm is preparing, never confirmed ready; the same durable event can recover', async () => {
  const f = fixture(); f.controls.failWarm = true;
  const launch = await f.launch();
  assert.equal(launch.publicationDelivery.ready, false);
  assert.equal(launch.publicationDelivery.projectionWarmed, false);
  assert.equal(launch.websiteStatus.state, 'preparing');
  assert.equal([...f.state().events.values()][0].status, 'RETRY');
  f.controls.failWarm = false;
  const retry = await f.launch({ expectedRevisionNumber: 5 });
  assert.equal(retry.websiteStatus.state, 'live');
  assert.equal(f.state().events.size, 1);
  assert.equal([...f.state().events.values()][0].status, 'PROCESSED');
});

test('access invalidation must succeed before any host/projection fill or Next callback', async () => {
  const f = fixture(); await f.access.resolve(f.adminId);
  f.redis.fail = true;
  const launch = await f.launch();
  assert.equal(launch.publicationDelivery.accessInvalidated, false);
  assert.equal(launch.publicationDelivery.cacheInvalidated, false);
  assert.equal(launch.publicationDelivery.ready, false);
  assert.equal(f.operations.includes('next.callback'), false);
  assert.equal(f.state().revisions.length, 1);
});

test('the existing worker delivery path recovers a committed publication after callback failure', async () => {
  const f = fixture(); f.controls.failCallback = true;
  const launch = await f.launch();
  assert.equal(launch.websiteStatus.state, 'preparing');
  const event = [...f.state().events.values()][0];
  f.controls.failCallback = false;
  // This is the exact same delivery function called by emailOutbox.worker.
  const recovered = await f.delivery.deliver(f.outbox.parsePublicWebsiteCacheInvalidationPayload(event.payload));
  assert.equal(recovered.delivered, true);
  assert.equal(recovered.ready, true);
  assert.equal(f.state().revisions.length, 1);
});

test('subscription horizon caps routing/projection TTL even with jitter, including stale copies', async () => {
  const f = fixture(); f.state().owner.subscription[0].currentPeriodEnd = new Date(Date.now() + 20_000);
  const result = await f.launch();
  const deadline = Date.parse(result.websiteStatus.validUntil);
  for (const [key, expires] of f.redis.expiry) {
    if (key.startsWith('website-host:') || key.startsWith('site-route:v10:subdomain:') || key.startsWith('website-projection:') || key.startsWith('site-projection-stale:')) {
      assert.ok(expires <= deadline + 2, `${key} outlived authorization`);
    }
  }
});

test('cached routes reject an expired override even when Redis TTL has not elapsed', async () => {
  const f = fixture(); await f.launch();
  const route = await f.host.resolveHost('cleaning-test.sites.example.com');
  const key = 'website-host:cleaning-test.sites.example.com';
  const value = JSON.parse(await f.redis.get(key));
  value.validUntil = new Date(Date.now() - 1).toISOString();
  await f.redis.set(key, JSON.stringify(value), 'EX', 300);
  f.state().owner.lifecycleStatus = 'SUSPENDED';
  await f.access.invalidate(f.adminId);
  const next = await f.host.resolveHost('cleaning-test.sites.example.com');
  assert.equal(route.availability, 'live');
  assert.equal(next.availability, 'suspended');
});

test('suspension and restoration rotate access before warming, using the existing durable topic', async () => {
  const f = fixture(); await f.launch();
  const before = await f.host.resolveHost('cleaning-test.sites.example.com');
  f.state().owner.lifecycleStatus = 'SUSPENDED';
  const suspended = await f.outbox.PublicWebsiteCacheOutbox.enqueueTenantDeliveryTx(f.db, f.adminId, 'tenant-suspended');
  const suspendedDelivery = await f.delivery.attemptImmediate(suspended);
  assert.equal(suspendedDelivery.delivered, true); assert.equal(suspendedDelivery.ready, false);
  assert.equal((await f.host.resolveHost('cleaning-test.sites.example.com')).availability, 'suspended');
  f.state().owner.lifecycleStatus = 'ACTIVE';
  const restored = await f.outbox.PublicWebsiteCacheOutbox.enqueueTenantDeliveryTx(f.db, f.adminId, 'tenant-restored');
  const restoredDelivery = await f.delivery.attemptImmediate(restored);
  const after = await f.host.resolveHost('cleaning-test.sites.example.com');
  assert.equal(restoredDelivery.ready, true); assert.equal(after.availability, 'live');
  assert.notEqual(after.accessGeneration, before.accessGeneration);
  assert.equal(f.state().revisions.length, 1);
  assert.deepEqual([...new Set([...f.state().events.values()].map(e => e.topic))], ['PUBLIC_WEBSITE_CACHE_INVALIDATION_REQUESTED']);
});
