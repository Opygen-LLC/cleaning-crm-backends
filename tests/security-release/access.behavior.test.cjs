const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { publicSecurityFixture: fixture } = require('../helpers/public-security-fixture.cjs');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');

test('cached live Redis data cannot bypass a committed suspension when invalidation delivery fails', async () => {
  const f = fixture(); await f.launch();
  await f.host.resolveHost('cleaning-test.sites.example.com');
  await f.publicWebsite.getPublicWebsiteById(f.websiteId);
  f.state().owner.lifecycleStatus = 'SUSPENDED';
  // Deliberately do not rotate Redis or invalidate any cache. This models a
  // failed delivery after the DB commit, not a happy-path DEL fixture.
  assert.equal((await f.host.resolveHost('cleaning-test.sites.example.com')).availability,'suspended');
  await assert.rejects(f.publicWebsite.getPublicWebsiteById(f.websiteId));
});
test('archival, pending deletion, owner deletion and unpublishing deny warm direct by-id reads', async () => {
  for (const kind of ['archive','delete','owner','unpublish']) {
    const f = fixture(); await f.launch(); await f.publicWebsite.getPublicWebsiteById(f.websiteId);
    if (kind === 'archive') f.state().owner.lifecycleStatus = 'ARCHIVED';
    if (kind === 'delete') f.state().owner.lifecycleStatus = 'PENDING_DELETION';
    if (kind === 'owner') f.state().owner.user.status = 'DELETED';
    if (kind === 'unpublish') f.state().website.status = 'DRAFT';
    await assert.rejects(f.publicWebsite.getPublicWebsiteById(f.websiteId));
    assert.notEqual((await f.host.resolveHost('cleaning-test.sites.example.com')).availability,'live');
  }
});
test('fresh access really bypasses a warm Redis decision; restoration needs no stale-TTL wait', async () => {
  const f=fixture(); await f.launch();
  f.state().owner.lifecycleStatus='SUSPENDED';
  assert.equal((await f.access.resolve(f.adminId,{fresh:true})).access.publicWebsiteAllowed,false);
  f.state().owner.lifecycleStatus='ACTIVE';
  assert.equal((await f.host.resolveHost('cleaning-test.sites.example.com')).availability,'live');
});
test('already warm routes cannot extend trial authorization deadlines', async () => {
  const f=fixture(); await f.launch(); await f.host.resolveHost('cleaning-test.sites.example.com');
  f.state().owner.subscription[0].isTrial=true;
  f.state().owner.subscription[0].trialEndsAt=new Date(Date.now()-1);
  assert.equal((await f.host.resolveHost('cleaning-test.sites.example.com')).availability,'suspended');
  await assert.rejects(f.publicWebsite.getPublicWebsiteById(f.websiteId));
});
test('Redis outage and recovery do not resurrect an old live authorization decision', async () => {
  const f=fixture(); await f.launch();
  f.redis.fail=true; f.state().owner.lifecycleStatus='SUSPENDED';
  assert.equal((await f.host.resolveHost('cleaning-test.sites.example.com')).availability,'suspended');
  f.redis.fail=false;
  assert.equal((await f.host.resolveHost('cleaning-test.sites.example.com')).availability,'suspended');
  await assert.rejects(f.publicWebsite.getPublicWebsiteById(f.websiteId));
});
test('an access-less legacy projection envelope is a cache miss, not a public response', async () => {
  const f=fixture(); await f.launch();
  const key=`website-projection:${f.websiteId}`;
  const value=JSON.parse(await f.redis.get(key));
  delete value.access; value.data={leaked:true};
  await f.redis.set(key, JSON.stringify(value),'EX',300);
  const projection=await f.publicWebsite.getPublicWebsiteById(f.websiteId);
  assert.equal(projection.leaked,undefined);
  assert.equal(projection.website.id,f.websiteId);
});
test('every Express entry strips internal headers from parsed and raw representations', () => {
  const {stripInternalRoutingHeaders}=loadTypeScript(path.join(__dirname,'../../src/middlewares/internalRoutingHeaders.ts'));
  const req={headers:{'x-website-id':'other-tenant','x-middleware-subrequest':'proxy',authorization:'Bearer token'},
    rawHeaders:['X-Website-ID','other-tenant','Authorization','Bearer token','X-Middleware-Subrequest','proxy']};
  let calls=0;stripInternalRoutingHeaders(req,{},()=>calls++);
  assert.deepEqual(req.headers,{authorization:'Bearer token'});
  assert.deepEqual(req.rawHeaders,['Authorization','Bearer token']); assert.equal(calls,1);
});
test('missing Prisma delegate fails with a configuration error rather than an allow-access fixture', async () => {
  const resolver=loadTypeScript(path.join(__dirname,'../../src/modules/Entitlement/tenantAccessResolver.service.ts'),{
    '../../config/redis':{get:async()=>null,set:async()=> 'OK'}, '../../lib/prisma/prisma':{prisma:{}},
    'http-status':{SERVICE_UNAVAILABLE:503},'../../errorHelper/AppError':class extends Error{constructor(statusCode,message,extra){super(message);Object.assign(this,{statusCode},extra);}},
    '../../lib/utils/subscriptionPlanFeatures':{},'./featureCatalog':{FEATURE_KEYS:[]},'../SuperAdmin/tenantEntitlement.service':{},
  });
  await assert.rejects(resolver.TenantAccessResolver.resolve('tenant',{authoritative:true}),{statusCode:503,code:'TENANT_ACCESS_CONFIGURATION_INVALID'});
});
test('unknown lifecycle/account/subscription values never receive allow-access by falling through', async () => {
  for (const field of ['lifecycle','account','subscription']) {
    const f=fixture(); await f.launch();
    if (field === 'lifecycle') f.state().owner.lifecycleStatus='UNKNOWN';
    if (field === 'account') f.state().owner.user.status='UNKNOWN';
    if (field === 'subscription') f.state().owner.subscription[0].status='UNKNOWN';
    const access=await f.access.resolve(f.adminId,{fresh:true});
    assert.equal(access.access.deniedReason,'ACCESS_CONFIGURATION_INVALID');
    assert.equal(access.access.recoveryAllowed,false);
    await assert.rejects(f.publicWebsite.getPublicWebsiteById(f.websiteId));
  }
});
test('an old warm projection cannot hide a newer committed revision when delivery was missed', async () => {
  const f=fixture();await f.launch();
  const before=await f.publicWebsite.getPublicWebsiteById(f.websiteId);
  f.state().website.publishedRevisionNumber += 1;
  f.state().website.publishedSnapshot.website.primaryColor='#123456';
  const after=await f.publicWebsite.getPublicWebsiteById(f.websiteId);
  assert.equal(after.website.publishedRevisionNumber,before.website.publishedRevisionNumber+1);
  assert.equal(after.theme.primaryColor,'#123456');
});
test('a live state with a missing committed revision fails closed even with a warm projection', async () => {
  const f=fixture();await f.launch();await f.publicWebsite.getPublicWebsiteById(f.websiteId);
  f.state().website.publishedRevisionNumber=null;
  await assert.rejects(f.publicWebsite.getPublicWebsiteById(f.websiteId),{code:'WEBSITE_PUBLICATION_REVISION_MISMATCH'});
  await assert.rejects(f.host.resolveHost('cleaning-test.sites.example.com'),{code:'WEBSITE_PUBLICATION_INVALID'});
});
test('a feature override expiry caps the cache horizon and is reevaluated on the next request', async () => {
  const f=fixture();await f.launch();
  const expiry=new Date(Date.now()+5000);
  f.state().owner.entitlementOverride={features:{custom_domain:'FORCE_ENABLED'},expiresAt:expiry};
  const before=await f.access.resolve(f.adminId,{fresh:true});
  assert.equal(before.effectiveEntitlements.custom_domain,true);
  assert.ok(Date.parse(before.validUntil)<=expiry.getTime());
  f.state().owner.entitlementOverride.expiresAt=new Date(Date.now()-1);
  const after=await f.access.resolve(f.adminId,{authoritative:true});
  assert.equal(after.effectiveEntitlements.custom_domain,false);
  assert.equal(after.tenantOverrides.active,false);
});
test('Socket.IO polling/upgrades sanitize routing hints before the existing session authenticator', async () => {
  let entry,auth;class Server{constructor(){this.engine={use:handler=>{entry=handler;}};}use(handler){auth=handler;}on(){}}
  const socketModule=loadTypeScript(path.join(__dirname,'../../src/config/socketio.ts'),{
    'socket.io':{Server},'../lib/prisma/prisma':{prisma:{}},'./ENV':{ACCESS_TOKEN_SECRET:'fixture'},
    './authSecurity':{getAuthenticatedOrigins:()=>['https://app.example.test']},'../lib/utils/jwt':{jwtUtils:{}},
    '../lib/logger':{warn:()=>{},debug:()=>{}},'../lib/realtime/realtimeBus':{startRealtimeSubscriber:()=>{}},
  });
  socketModule.default({});const req={headers:{cookie:'session=value','x-website-id':'forged'},rawHeaders:['Cookie','session=value','X-Website-ID','forged']};
  let next=0;entry(req,{},()=>next++);assert.equal(next,1);assert.deepEqual(req.headers,{cookie:'session=value'});assert.deepEqual(req.rawHeaders,['Cookie','session=value']);
  const socket={handshake:{headers:{}},data:{}};let denied;await auth(socket,error=>{denied=error;});assert.equal(denied?.message,'unauthorized');
});
