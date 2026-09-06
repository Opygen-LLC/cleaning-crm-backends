const path = require('node:path');
const { createSourceLoader } = require('./load-source.cjs');
const { MemoryRedis } = require('./memory-redis.cjs');
const ROOT = process.env.PHASE1_SOURCE_ROOT || path.resolve(__dirname, '../..');
const SITE = '12345678-1234-4234-8234-123456789abc';
const ADMIN = 'admin-1', USER = 'user-1', HOST = 'sparkle.sites.example.test';
function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function fixture() {
  // Deterministic model time: only explicit test advances affect expiry.
  const startedAt = Date.now();
  const clock = { offset: 0, now() { return startedAt + this.offset; } };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now()])); } static now() { return clock.now(); } }
  const redis = new MemoryRedis(() => clock.now());
  const control = { nextFails: false, failOutbox: false, bumpFails: false, warmMismatch: false, holdAccess: null, reads: 0 };
  const order = [];
  let state = {
    site: { id:SITE, adminId:ADMIN, subdomain:'sparkle', status:'DRAFT', templateId:'clean-modern', templateVersion:'1.0.0', schemaVersion:1,
      primaryColor:'#0F766E', secondaryColor:'#0F172A', accentColor:'#14B8A6', font:null, logo:null, favicon:null, websiteDesign:{},
      bookingEnabled:false, estimateEnabled:false, primaryBookingFormId:null, primaryEstimateFormId:null, metaKeywords:[], socialImageUrl:null,
      draftRevisionNumber:5, publishedRevisionNumber:null, publishedAt:null, publishedSnapshot:null,
      pages:[{id:'home',kind:'HOME',slug:'/',title:'Home',content:{},isEnabled:true,showInNavigation:true,sortOrder:0}],
      subdomainAliases:[], domains:[], assets:[], primaryBookingForm:null,primaryEstimateForm:null },
    owner: {id:ADMIN,userId:USER,businessName:'Sparkle',businessEmail:'owner@example.test',onboardingCompletedAt:null,
      onboardingCompletedSteps:['business_profile','branding','services','website_address','review_launch'], lifecycleStatus:'ACTIVE',
      user:{id:USER,email:'owner@example.test',status:'ACTIVE'}, entitlementOverride:null,
      subscription:[{id:'subscription-1',status:'ACTIVE',isTrial:false,currentPeriodEnd:new Date(Date.now()+86_400_000),extraStaff:0,extraClient:0,extraBookingsPerMonth:0,
        plan:{id:'price-1',maxStaff:10,maxClient:100,maxBookingsPerMonth:100},subscriptionPlan:{id:'plan-1',name:'PRO',features:[]}}]},
    revisions:[], events:[]
  };
  const clone = x => structuredClone(x);
  function db(readState, inTransaction=false) {
    const website = () => ({...clone(readState().site),admin:{id:ADMIN,businessName:readState().owner.businessName}});
    return {
      businessWebsite:{
        findUnique:async ({where}) => { const site = readState().site; if (!site || (where.id && where.id!==SITE) || (where.subdomain && where.subdomain!==site.subdomain)) return null; return website(); },
        findFirst:async ({where}) => where?.subdomain ? null : website(),
        update:async ({data}) => { Object.assign(readState().site,clone(data)); order.push('website:update'); return website(); },
      },
      adminProfile:{
        findUnique:async () => { control.reads++; const value={...clone(readState().owner),businessWebsite:website()}; if (!inTransaction && control.holdAccess) {const hold=control.holdAccess;control.holdAccess=null;hold.started.resolve();await hold.release.promise;} return value; },
        update:async ({data}) => { Object.assign(readState().owner,clone(data));order.push('onboarding:update');return clone(readState().owner); },
      },
      websiteRevision:{aggregate:async()=>({_max:{revisionNumber:Math.max(5,...readState().revisions.map(r=>r.revisionNumber))}}),create:async({data})=>{const r={...clone(data),id:`revision-${data.revisionNumber}`};readState().revisions.push(r);order.push('revision:create');return clone(r);}},
      websiteSubdomainAlias:{findUnique:async()=>null,findFirst:async()=>null}, websiteDomain:{findFirst:async()=>null},
      bookingForm:{findFirst:async()=>null}, estimateForm:{findFirst:async()=>null},
      outboxEvent:{
        upsert:async ({where,create}) => {if(control.failOutbox)throw new Error('TEST_OUTBOX_INSERT_FAILED');let event=readState().events.find(e=>e.dedupeKey===where.dedupeKey);if(!event){event={...clone(create),id:`event-${readState().events.length+1}`,status:'PENDING',lockedAt:null,attempts:0};readState().events.push(event);order.push('outbox:insert');}return clone(event);},
        create:async ({data}) => {if(control.failOutbox)throw new Error('TEST_OUTBOX_INSERT_FAILED'); const event={...clone(data),id:`event-${readState().events.length+1}`,status:'PENDING',lockedAt:null,attempts:0};readState().events.push(event);order.push('outbox:insert');return clone(event);},
        findUnique:async ({where}) => clone(readState().events.find(e=>where.id ? e.id===where.id : e.dedupeKey===where.dedupeKey)??null),
        updateMany:async ({where,data}) => {const matches=readState().events.filter(e=>e.id===where.id&&(!where.status?.in||where.status.in.includes(e.status))&&(where.lockedAt!==null||e.lockedAt===null));matches.forEach(e=>Object.assign(e,clone(data)));return {count:matches.length};},
      }
    };
  }
  const prisma = db(()=>state); let serial=Promise.resolve();
  prisma.$transaction = (fn) => {
    const result = serial.then(async()=> {order.push('transaction:start');let working=clone(state);try {const result=await fn(db(()=>working,true));state=working;order.push('transaction:commit');return result;}catch(error){order.push('transaction:rollback');throw error;}});
    serial=result.catch(()=>{});return result;
  };
  const env={WEBSITE_BASE_DOMAIN:'sites.example.test',WEBSITE_CUSTOM_DOMAINS_ENABLED:false,
    WEBSITE_ROUTE_CACHE_TTL_SECONDS:300,WEBSITE_ROUTE_CACHE_JITTER_RATIO:0.2,WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS:10,WEBSITE_ROUTE_REBUILD_LOCK_SECONDS:8,WEBSITE_ROUTE_WAIT_FOR_FILL_MS:40,
    WEBSITE_PROJECTION_CACHE_TTL_SECONDS:180,WEBSITE_PROJECTION_CACHE_JITTER_RATIO:0,WEBSITE_PROJECTION_STALE_TTL_SECONDS:900,WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS:8,WEBSITE_PROJECTION_WAIT_FOR_FILL_MS:40,WEBSITE_STUDIO_CACHE_TTL_SECONDS:60,
    NEXT_REVALIDATE_URL:'https://app.example.test/api/public-site/revalidate',NEXT_REVALIDATE_SECRET:'test-only-not-a-real-secret-32chars',NEXT_REVALIDATE_TIMEOUT_MS:100};
  let load;
  const entitlements={basicWebsite:true,freeSubdomain:true,onlineBooking:true,customDomains:false,customDomainLimit:0,premiumTemplates:true,advancedSeo:true,planName:'PRO'};
  const mocks={
    'http-status':{NOT_FOUND:404,CONFLICT:409,BAD_REQUEST:400,FORBIDDEN:403,UNPROCESSABLE_ENTITY:422,SERVICE_UNAVAILABLE:503},
    'src/config/ENV':env,'src/config/redis':{default:redis,__esModule:true},'src/lib/prisma/prisma':{prisma},
    'src/lib/logger':{default:{warn:()=>{},info:()=>{},error:()=>{}},__esModule:true},
    'src/lib/prisma/advisoryLock':{acquireTextTransactionAdvisoryLock:async()=>{order.push('advisory:lock');}},
    'src/lib/prisma/transactionPolicy':{PROVISIONING_TRANSACTION_OPTIONS:{timeout:10000}},
    'src/lib/utils/resolveAdminId':{getAdminId:async()=>ADMIN},'src/lib/utils/cloudinary':{},
    'src/modules/Admin/admin.constant':{ONBOARDING_STEPS:['business_profile','branding','services','website_address','review_launch'].map(key=>({key}))},
    'src/lib/utils/subscriptionPlanFeatures':{normalizeSubscriptionPlanFeatures:value=>Array.isArray(value)?value:[]},
    'src/modules/SuperAdmin/tenantEntitlement.service':{
      isOverrideActive:(value,now)=>!!value&&(!value.expiresAt||value.expiresAt>now),readFeatureOverrides:value=>value||{},readResourceOverrides:value=>value||{},applyNumericResourceOverride:(base,value)=>value?.value??base},
    'src/modules/Website/websiteEntitlement.service':{WebsiteEntitlementService:{getForAdminId:async()=>({...entitlements}),assertTemplateAllowed:()=>{}}},
    'src/modules/Website/websiteIdentity':{normalizeSubdomain:value=>value.trim().toLowerCase(),assertSafeHttpsUrl:value=>value},
    'src/modules/Website/templateRegistry':{TemplateRegistry:{requireTemplate:()=>({id:'clean-modern',version:'1.0.0',schemaVersion:1})}},
    'src/modules/Website/templateSelection':{buildTemplateSelectionPatch:()=>({})},'src/modules/Website/websiteProvisioning.service':{WebsiteProvisioningService:{}},
    'src/modules/Website/websiteBookingProvisioning.service':{WebsiteBookingProvisioningService:{ensureAttachedForLaunchTx:async()=>null}},
    'src/modules/Website/websiteSnapshot':{buildPublishedSnapshot:draft=>({version:1,website:clone(draft),pages:clone(draft.pages)}),parsePublishedSnapshot:value=>value??null,parseRevisionSnapshotAsPublished:value=>value,buildWebsitePublicationFingerprint:()=>({hash:'test-model-fingerprint'})},
    'src/modules/Website/websiteDomainReadiness':{readyWebsiteDomainWhere:{},isWebsiteDomainRoutingReady:()=>false},'src/modules/Website/websiteDomainLifecycle':{presentWebsiteDomain:value=>value},
    'src/modules/Website/websiteContent':{validateWebsitePageContent:(_kind,value)=>value},'src/modules/Website/websiteDesignContract':{parseWebsiteDesignContract:value=>value??{}},'src/modules/Website/websiteComponentRegistry':{assertWebsiteDesignPublishable:()=>{}},
    'src/modules/Website/website.interface':{WEBSITE_EDITOR_SURFACES:['content','branding','seo','booking','templates','domain']},
    'src/lib/cache/resourceCacheVersion':{CacheResource:{website:'website',onboarding:'onboarding',profile:'profile'},bumpCacheResourceVersions:async()=>{if(control.bumpFails){control.bumpFails=false;throw new Error('TEST_POST_COMMIT_TIMEOUT');}}},
    'src/modules/Website/publicWebsite.service':{PublicWebsiteService:{getPublicWebsiteById:async id=>{
      const access=await load('src/modules/Entitlement/tenantAccessResolver.service.ts').TenantAccessResolver.resolve(ADMIN);
      if(!access.access.publicWebsiteAllowed)throw new Error('TEST_ACCESS_DENIED');
      return load('src/modules/Website/websiteProjectionCache.service.ts').WebsiteProjectionCacheService.getOrLoad(id,async()=>({website:{id,publishedRevisionNumber:control.warmMismatch?-1:state.site.publishedRevisionNumber,canonicalUrl:`https://${HOST}`,accessValidUntil:access.cache?.validUntil}}));
    }}},
  };
  load=createSourceLoader(ROOT,mocks,{Date:ClockDate,fetch:async()=>{order.push('next:deliver');if(control.nextFails)throw new Error('TEST_NEXT_TIMEOUT');return {ok:true,status:200};}});
  return {load,prisma,redis,control,clock,order,get state(){return state;},get access(){return load('src/modules/Entitlement/tenantAccessResolver.service.ts').TenantAccessResolver;},get host(){return load('src/modules/Website/websiteHostResolver.service.ts').WebsiteHostResolverService;},get projection(){return load('src/modules/Website/websiteProjectionCache.service.ts').WebsiteProjectionCacheService;},get service(){return load('src/modules/Website/website.service.ts').WebsiteService;}};
}
module.exports={fixture,deferred,SITE,ADMIN,USER,HOST};
