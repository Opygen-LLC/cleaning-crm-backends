const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/launch-fixture.cjs');

// These three cases and frontend navigation.behavior.test.cjs form the four
// baseline regressions. They exercise behavior on both the supplied baseline
// and this patch (PHASE1_SOURCE_ROOT selects the baseline source tree).
const legacyReview = f => f.state().owner.onboardingCompletedSteps.push('review_launch');

test('R1: cached DRAFT access -> launch -> FIRST canonical host resolves the published website', async () => {
  const f = fixture(); legacyReview(f);
  const before = await f.access.resolve(f.adminId);
  assert.equal(before.access.publicWebsiteAllowed, false);
  const launch = await f.launch({ expectedRevisionNumber: 5 });
  const host = await f.host.resolveHost('cleaning-test.sites.example.com');
  assert.equal(host.websiteId, launch.website.id);
  assert.equal(host.availability, 'live');
});

test('R3: concurrent same-revision launch requests return one site and one publication revision', async () => {
  const f = fixture(); legacyReview(f);
  const outcomes = await Promise.allSettled([
    f.launch({ expectedRevisionNumber: 5 }), f.launch({ expectedRevisionNumber: 5 }),
  ]);
  assert.deepEqual(outcomes.map(r => r.status), ['fulfilled', 'fulfilled']);
  assert.equal(outcomes[0].value.website.id, outcomes[1].value.website.id);
  assert.equal(outcomes[0].value.website.publishedRevisionNumber, outcomes[1].value.website.publishedRevisionNumber);
  assert.equal(f.state().revisions.length, 1);
});

test('R4: response lost AFTER commit -> retry ORIGINAL expected revision without republishing', async () => {
  const f = fixture(); legacyReview(f);
  // Simulate the network dropping the successful result. Do not consume or
  // adopt its new revision, exactly as a disconnected browser would behave.
  await f.launch({ expectedRevisionNumber: 5 });
  const committed = f.state().website.publishedRevisionNumber;
  const retry = await f.launch({ expectedRevisionNumber: 5 });
  assert.equal(retry.alreadyLive, true);
  assert.equal(retry.website.publishedRevisionNumber, committed);
  assert.equal(f.state().revisions.length, 1);
});
