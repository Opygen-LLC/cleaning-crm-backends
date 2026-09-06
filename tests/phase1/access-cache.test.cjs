const {test}=require('node:test');const assert=require('node:assert/strict');const {fixture,deferred,ADMIN,HOST,SITE,USER}=require('./backend-fixture.cjs');
test('an old in-flight access lookup cannot repopulate a deleted entry or return the pre-launch decision',async()=>{
 const f=fixture();const hold={started:deferred(),release:deferred()};f.control.holdAccess=hold;
 const old=f.access.resolve(ADMIN);await hold.started.promise;
 f.state.site.status='PUBLISHED';await f.access.invalidate(ADMIN);hold.release.resolve();
 const result=await old;assert.equal(result.access.publicWebsiteAllowed,true);assert.equal((await f.access.resolve(ADMIN)).access.publicWebsiteAllowed,true);assert.ok(f.control.reads>=2);
});
test('routing TTL is clipped to sub-second subscription expiry and denies at the exact deadline',async()=>{
 const f=fixture();f.state.site.status='PUBLISHED';const expiry=f.clock.now()+750;f.state.owner.subscription[0].currentPeriodEnd=new Date(expiry);
 const route=await f.host.resolveHost(HOST);assert.equal(route.availability,'live');assert.equal(Date.parse(route.accessValidUntil),expiry);
 const writes=f.redis.writes.filter(w=>w.key==='website-host:'+HOST||/^site-route:v\d+:subdomain:sparkle$/.test(w.key));
 assert.ok(writes.length>=2);for(const w of writes)assert.ok(w.ttlMs<=750&&w.at+w.ttlMs<=expiry+2);
 f.clock.offset+=751;assert.equal((await f.host.resolveHost(HOST)).availability,'suspended');
});
test('override expiry is enforced even with warm host and projection caches',async()=>{
 const f=fixture();f.state.site.status='PUBLISHED';f.state.owner.entitlementOverride={features:{website:'FORCE_DISABLED'},resources:{},expiresAt:new Date(f.clock.now()+750)};
 assert.equal((await f.host.resolveHost(HOST)).availability,'unpublished');f.clock.offset+=751;
 assert.equal((await f.host.resolveHost(HOST)).availability,'live');
});
test('suspension and restoration invalidate dependent routing by the tenant generation',async()=>{
 const f=fixture();f.state.site.status='PUBLISHED';assert.equal((await f.host.resolveHost(HOST)).availability,'live');
 f.state.owner.lifecycleStatus='SUSPENDED';await f.access.invalidate(ADMIN);assert.equal((await f.host.resolveHost(HOST)).availability,'suspended');
 f.state.owner.lifecycleStatus='ACTIVE';await f.access.invalidate(ADMIN);assert.equal((await f.host.resolveHost(HOST)).availability,'live');
});
test('access fails closed without its database delegate; Redis loss still uses authoritative SQL',async()=>{
 const f=fixture();f.redis.down=true;f.state.owner.lifecycleStatus='SUSPENDED';assert.equal((await f.access.resolve(ADMIN)).access.dashboardAllowed,false);
 delete f.prisma.adminProfile;await assert.rejects(f.access.resolve(ADMIN),error=>error.code==='TENANT_ACCESS_STORAGE_UNAVAILABLE');
});
test('projection fresh and stale copies share an absolute authorization ceiling',async()=>{
 const f=fixture(),expiry=f.clock.now()+750;const result=await f.projection.set(SITE,{website:{id:SITE,accessValidUntil:new Date(expiry).toISOString()}});assert.equal(result,true);
 const writes=f.redis.writes.filter(w=>w.key.startsWith('website-projection:')||w.key.startsWith('site-projection-stale:'));
 assert.equal(writes.length,2);for(const w of writes)assert.ok(w.at+w.ttlMs<=expiry+2);
 f.clock.offset+=751;assert.equal(await f.projection.get(SITE),null);
});
test('a durable old event never warms or resurrects a suspended tenant',async()=>{
 const f=fixture();await f.service.launchWebsite({}, {id:USER});f.state.owner.lifecycleStatus='SUSPENDED';
 const result=await f.load('src/modules/Website/websitePublicationDelivery.service.ts').WebsitePublicationDeliveryService.deliver(f.state.events[0].payload);
 assert.equal(result.completed,true);assert.equal(result.ready,false);assert.equal(result.state,'temporarily_unavailable');assert.equal(result.projectionWarmed,false);
});
test('lifecycle work uses the same durable outbox but cannot collide with publication receipts',async()=>{
 const f=fixture();const outbox=f.load('src/lib/outbox/publicWebsiteCacheOutbox.ts').PublicWebsiteCacheOutbox;
 await f.prisma.$transaction(async tx=>{await outbox.enqueueTenantAccessChangeTx(tx,ADMIN,'tenant-suspended');await outbox.enqueueTenantAccessChangeTx(tx,ADMIN,'tenant-restored');});
 assert.equal(f.state.events.length,2);assert.ok(f.state.events.every(e=>e.topic==='PUBLIC_WEBSITE_DELIVERY_REQUESTED'&&e.payload.accessChange.adminId===ADMIN));
});
