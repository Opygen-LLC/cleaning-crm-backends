const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loadTypeScript}=require('../helpers/load-typescript.cjs');
const {inspectWebsiteForRelease,auditReferencedValues}=loadTypeScript(path.join(__dirname,'../../src/scripts/release/websiteReleaseChecks.ts'));
const {readAuditOptions,reconcileWebsiteRelease}=loadTypeScript(path.join(__dirname,'../../src/scripts/release/websiteReleaseAudit.ts'));
const registry={templates:[{id:'clean-modern',version:'1.0.0',schemaVersion:1},{id:'clean-modern',version:'2.0.0',schemaVersion:1}],components:[{id:'shared.header.minimal.v1',slot:'shared.header',status:'ACTIVE'}],parseSnapshot:v=>v?.version===1&&v.website&&Array.isArray(v.pages)?v:null,validDesign:v=>v?.schemaVersion===1};
const make=()=>{
 const row={id:'website',adminId:'owner',status:'PUBLISHED',templateId:'clean-modern',templateVersion:'1.0.0',schemaVersion:1,websiteDesign:{schemaVersion:1,componentOverrides:{}},draftRevisionNumber:12,publishedRevisionNumber:5,publishedAt:'2026-01-01T00:00:00Z',maximumRevision:5,revisionCount:3,publicationRevisionExists:true,onboardingCompletedSteps:['business_profile','branding','services','website_address','review_launch'],onboardingCompletedAt:'2026-01-01T00:00:00Z',activeServices:205,publicationDeliveryEventId:'event',publicationDeliveryReceipt:{ready:true,delivered:true,revision:2,projectionWarmed:true,projectionRevisionVerified:true,revalidationDelivered:true,canonicalHostVerified:true},pages:[]};
 row.publicationDeliveryReceipt.revision=row.publishedRevisionNumber;
 row.publishedSnapshot={version:1,website:{...row},pages:[]};row.publicationRevisionSnapshot=structuredClone(row.publishedSnapshot);return row;
};
const codes=row=>inspectWebsiteForRelease(row,registry).map(i=>i.code);
test('read-only rules accept retained old renderers and legitimate autosave counters ahead of history',()=>{
 const row=make(),before=structuredClone(row);assert.deepEqual(codes(row),[]);assert.deepEqual(row,before);
 row.templateVersion='2.0.0';assert.deepEqual(codes(row),[]);
});
test('reports broken publication, completed-without-publication, missing initial revision and regressed counters',()=>{
 const row=make();row.publishedSnapshot=null;row.publicationRevisionExists=false;row.revisionCount=0;row.draftRevisionNumber=1;
 const found=codes(row);for(const code of ['INVALID_PUBLICATION','COMPLETED_WITHOUT_PUBLICATION','MISSING_INITIAL_REVISION','REVISION_COUNTER_BEHIND'])assert.ok(found.includes(code));
});
test('unknown stored template/components cannot be hidden by a permissive runtime projection parser',()=>{
 const row=make();row.publishedSnapshot.website.templateVersion='9.9.9';row.websiteDesign.componentOverrides={shared:{header:'home.hero.unknown.v9'}};
 assert.ok(codes(row).includes('UNKNOWN_TEMPLATE_VERSION'));assert.ok(codes(row).includes('UNKNOWN_OR_MISPLACED_COMPONENT'));
});
test('tenant-owned form/asset/page references are checked for drafts and snapshots',()=>{
 const row=make();row.logo='https://media.example.test/foreign.png';row.primaryBookingFormId='foreign-form';row.pages=[{id:'foreign-page',kind:'HOME',content:{heroImageUrl:row.logo}}];
 row.assets=[{url:row.logo,websiteId:'other',mimeType:'image/png'}];row.forms=[{id:'foreign-form',kind:'booking',adminId:'other'}];row.pageOwners=[{id:'foreign-page',websiteId:'other'}];
 for(const code of ['INVALID_FORM_OWNERSHIP','INVALID_ASSET_OWNERSHIP','INVALID_PAGE_OWNERSHIP'])assert.ok(codes(row).includes(code));
 const refs=auditReferencedValues(row);assert.deepEqual(refs.formIds,['foreign-form']);assert.deepEqual(refs.urls,[row.logo]);
});
test('intentional clears and legacy external ABOUT photos are not misclassified as foreign managed assets',()=>{
 const row=make();row.logo=null;row.favicon=null;row.pages=[{kind:'ABOUT',content:{imageUrl:'https://example.test/legacy.jpg'}}];assert.deepEqual(codes(row),[]);
});
test('empty services and malformed/duplicate legacy progress are reported without modifying data',()=>{
 const row=make();row.activeServices=0;row.onboardingCompletedSteps.push('template');assert.ok(codes(row).includes('MISSING_ACTIVE_SERVICES'));assert.ok(codes(row).includes('DUPLICATE_ONBOARDING_MILESTONES'));
 row.onboardingCompletedSteps=['bad-key'];assert.ok(codes(row).includes('MALFORMED_ONBOARDING_PROGRESS'));
});
test('audit cannot accept fix flags, unbounded batch sizes, or duplicate options',()=>{
 for(const args of [['--fix'],['--batch-size=0'],['--batch-size=1;DELETE'],['--sample-limit=999999'],['--output=a','--output=b']])assert.throws(()=>readAuditOptions(args));
});
function database({fail=false,rows=[],errors=[]}={}) {
 const calls=[];let scanned=false;
 return {calls,query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.startsWith('SELECT current_setting'))return {rows:[{read_only:'on',isolation:'repeatable read',schema:'public'}]};
  if(sql.includes('SELECT COUNT(*)::int AS count'))return {rows:[{count:rows.length}]};
  if(sql.startsWith('FETCH'))return {rows:errors.splice(0,100)};
  if(sql.startsWith('SELECT w.*')){if(fail)throw new Error('timeout');if(scanned) return {rows:[]};scanned=true;return {rows};}
  return {rows:[]};
 }};
}
test('audit executes a read-only repeatable snapshot and records exact counts with bounded per-code samples',async()=>{
 const db=database({rows:[make()],errors:[{code:'COLLISION',severity:'error',reason:'one'},{code:'COLLISION',severity:'error',reason:'two'}]});
 const result=await reconcileWebsiteRelease(db,readAuditOptions(['--sample-limit=1']),registry);
 assert.equal(db.calls[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(db.calls.at(-1).sql,'COMMIT');
 assert.equal(result.summary.byCode.COLLISION,2);assert.equal(result.samples.length,1);assert.equal(result.safeToProceed,false);assert.equal(result.websites.scanned,1);
 assert.equal(db.calls.some(c=>/^(UPDATE|DELETE|INSERT|TRUNCATE|ALTER|DROP)\s/i.test(c.sql)),false);
});
test('read failure rolls back and throws, never emits a partial successful reconciliation',async()=>{
 const db=database({rows:[make()],fail:true});await assert.rejects(reconcileWebsiteRelease(db,readAuditOptions([]),registry),/timeout/);assert.equal(db.calls.at(-1).sql,'ROLLBACK');
});
test('an audit bound that excludes rows fails rather than returning an apparently clean partial scan',async()=>{
 const db=database({rows:[make(),make()]});await assert.rejects(reconcileWebsiteRelease(db,readAuditOptions(['--max-websites=1']),registry),/exceeds/);assert.equal(db.calls.at(-1).sql,'ROLLBACK');
});
test('audit detects divergence between the immutable publication and its exact revision, ignoring object-key order',()=>{
 const row=make();row.publicationRevisionSnapshot.website.primaryColor='#123456';assert.ok(codes(row).includes('PUBLICATION_REVISION_MISMATCH'));
 row.publicationRevisionSnapshot=structuredClone(row.publishedSnapshot);row.publicationRevisionSnapshot.website=Object.fromEntries(Object.entries(row.publicationRevisionSnapshot.website).reverse());assert.equal(codes(row).includes('PUBLICATION_REVISION_MISMATCH'),false);
});
