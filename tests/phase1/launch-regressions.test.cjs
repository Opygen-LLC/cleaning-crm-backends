const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,SITE,ADMIN,USER,HOST}=require('./backend-fixture.cjs');
const user={id:USER,role:'ADMIN'};

test('regression: cached DRAFT access launches and the first canonical-host request resolves the committed website/revision',async()=>{
 const f=fixture();assert.equal((await f.access.resolve(ADMIN)).access.publicWebsiteAllowed,false);
 assert.equal((await f.host.resolveHost(HOST)).availability,'unpublished');
 const result=await f.service.launchWebsite({expectedRevisionNumber:5},user);
 const route=await f.host.resolveHost(HOST);
 assert.equal(route.websiteId,SITE);assert.equal(route.availability,'live');
 assert.equal(result.publicationDelivery.ready,true);assert.equal(result.publicationDelivery.canonicalHostVerified,true);
 assert.equal((await f.projection.get(SITE)).website.publishedRevisionNumber,result.website.publishedRevisionNumber);
 assert.equal(f.state.events.length,1);assert.equal(f.state.events[0].status,'PROCESSED');
 assert.ok(f.order.indexOf('outbox:insert')<f.order.indexOf('transaction:commit'));
 assert.ok(f.order.indexOf('next:deliver')>f.order.indexOf('transaction:commit'));
});
test('regression: final review, publication and onboarding complete atomically in one launch mutation',async()=>{
 const f=fixture();f.state.owner.onboardingCompletedSteps=f.state.owner.onboardingCompletedSteps.filter(x=>x!=='review_launch');
 const result=await f.service.launchWebsite({},user);
 assert.ok(f.state.owner.onboardingCompletedSteps.includes('review_launch'));
 assert.ok(f.state.owner.onboardingCompletedAt);assert.ok(f.state.site.publishedSnapshot);
 assert.equal(result.completion.userId,USER);assert.equal(result.completion.organizationId,ADMIN);
 assert.equal(f.state.revisions.length,1);assert.equal(f.state.events.length,1);
});
test('regression: repeated launch, stale expected revision, old editor payload and a newer draft do not republish',async()=>{
 const f=fixture();const first=await f.service.launchWebsite({expectedRevisionNumber:5},user);
 f.state.site.draftRevisionNumber=7;f.state.revisions.push({revisionNumber:7,reason:'newer independent draft'});
 const retry=await f.service.launchWebsite({expectedRevisionNumber:5,website:{primaryColor:'#FFFFFF'}},user);
 assert.equal(retry.alreadyLive,true);assert.equal(retry.website.id,first.website.id);
 assert.equal(retry.website.publishedRevisionNumber,first.website.publishedRevisionNumber);
 assert.equal(f.state.revisions.filter(r=>r.reason==='Website launched').length,1);assert.equal(f.state.events.length,1);
});
test('regression: a post-commit timeout/lost response is retryable without another website or publication revision',async()=>{
 const f=fixture();
 const loseResponse=async()=>{await f.service.launchWebsite({expectedRevisionNumber:5},user);throw new Error('TEST_POST_COMMIT_TIMEOUT');};
 await assert.rejects(loseResponse(),/TEST_POST_COMMIT_TIMEOUT/);
 assert.ok(f.state.owner.onboardingCompletedAt);assert.equal(f.state.revisions.length,1);
 const retry=await f.service.launchWebsite({expectedRevisionNumber:5},user);
 assert.equal(retry.alreadyLive,true);assert.equal(retry.website.publishedRevisionNumber,6);assert.equal(f.state.revisions.length,1);
});
test('outbox insertion failure rolls back publication, revision and onboarding',async()=>{
 const f=fixture();f.control.failOutbox=true;
 await assert.rejects(f.service.launchWebsite({},user),/TEST_OUTBOX_INSERT_FAILED/);
 assert.equal(f.state.site.status,'DRAFT');assert.equal(f.state.site.publishedSnapshot,null);assert.equal(f.state.owner.onboardingCompletedAt,null);
 assert.equal(f.state.revisions.length,0);assert.equal(f.state.events.length,0);assert.ok(!f.order.includes('next:deliver'));
});
test('two concurrent launch requests converge on one site, one publication and one outbox row',async()=>{
 const f=fixture();const responses=await Promise.all([f.service.launchWebsite({expectedRevisionNumber:5},user),f.service.launchWebsite({expectedRevisionNumber:5},user)]);
 assert.equal(f.state.revisions.length,1);assert.equal(f.state.events.length,1);assert.ok(responses.every(x=>x.website.id===SITE&&x.website.publishedRevisionNumber===6));
 assert.ok(f.order.includes('advisory:lock'));
});
test('cache delivery timeout is preparing, durably queued, and recoverable by the existing outbox worker path',async()=>{
 const f=fixture();f.control.nextFails=true;const result=await f.service.launchWebsite({},user);
 assert.equal(result.publicationDelivery.ready,false);assert.equal(result.publicationDelivery.revalidationDelivered,false);
 assert.equal(result.publicationDelivery.revalidationQueued,true);assert.equal(f.state.events[0].status,'PENDING');assert.ok(f.state.owner.onboardingCompletedAt);
 f.control.nextFails=false;const receipt=f.state.events[0];
 const delivered=await f.load('src/modules/Website/websitePublicationDelivery.service.ts').WebsitePublicationDeliveryService.deliver(receipt.payload);
 assert.equal(delivered.completed,true);assert.equal(delivered.ready,true);assert.equal(f.state.revisions.length,1);
});
test('a DB fallback after Redis warming failure is never confirmed readiness',async()=>{
 const f=fixture();f.redis.failProjectionWrites=true;const result=await f.service.launchWebsite({},user);
 assert.equal(result.publicationDelivery.projectionWarmed,false);assert.equal(result.publicationDelivery.ready,false);assert.equal(result.publicationDelivery.revalidationQueued,true);
});
test('mismatched projection revision is never confirmed readiness',async()=>{
 const f=fixture();f.control.warmMismatch=true;const result=await f.service.launchWebsite({},user);
 assert.equal(result.publicationDelivery.ready,false);assert.ok(result.publicationDelivery.errors.includes('PUBLICATION_PROJECTION_NOT_CONFIRMED'));
});
test('Redis outage does not masquerade as cache invalidation or readiness',async()=>{
 const f=fixture();f.redis.down=true;const result=await f.service.launchWebsite({},user);
 assert.equal(result.publicationDelivery.cacheInvalidated,false);assert.equal(result.publicationDelivery.ready,false);assert.equal(result.publicationDelivery.revalidationTriggered,false);
 assert.equal(result.publicationDelivery.revalidationQueued,true);assert.equal(f.state.site.status,'PUBLISHED');
});
