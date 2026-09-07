import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { evaluateEvidence, validateFreshReport } from '../../scripts/release/phase6EvidenceGate.mjs';
import { validateCohort, runCanary } from '../../scripts/release/phase6Canary.mjs';
const expected={frontend:'a'.repeat(40),backend:'b'.repeat(40)};
const releases={frontend:{gitSha:expected.frontend},backend:{gitSha:expected.backend}};
const now=()=>new Date().toISOString();
const base=()=>({schemaVersion:1,startedAt:now(),finishedAt:now(),source:'live-staging',passed:true,cleanup:true,releases});
function evidence() {
 const directory=mkdtempSync(join(tmpdir(),'phase6-test-evidence-'));
 const write=(name,value)=>{const path=join(directory,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
 for(const [folder,expectedOtp] of [['otp-enabled',true],['otp-disabled',false]]) for(const scenario of ['clean','lost-response-retry']) write(`${folder}/${scenario}.json`,{...base(),scenario,expectedOtp,firstCanonicalRequest:{status:200},checks:{dashboardNavigations:1,savedFieldsRoundTrip:true,cachedDraftPrimed:true,unpublishedForgeryDenied:true,firstCanonicalWebsiteAndRevision:true,liveForgeryCannotChangeIdentity:true,repeatCreatesNoRevision:true}});
 for(const templateVersion of ['1.0.0','2.0.0','3.0.0']) write(`studio/studio-${templateVersion}.json`,{...base(),suite:'website-studio',templateVersion,checks:{immediatePublish:true,rapidSelection:true,trailingSave:true,immediatePublicRevision:true,templates:['clean-modern','premium-home','commercial-pro','local-cleaning']}});
 write('interface/interface-evidence.json',{...base(),checks:{localPreviewWithoutKeystrokeRequests:true,inlineErrorAndFailedSavePreserveInput:true,savedBrandingReloadAndAccessibleNames:true,reviewRequiresExplicitLaunch:true,completeCatalogRowsRetained:205},viewports:[390,768,1440].map(width=>({width,overflow:false,unlabeled:[],primaryCount:1}))});
 const audit={...base(),source:'database-snapshot',sourceRevision:expected.backend,readOnly:true,mode:'read-only',isolation:'repeatable read',complete:true,websites:{total:2,scanned:2},safeToProceed:true,summary:{errors:0,warnings:0}};
 write('reconciliation.json',audit);
 write('platform-wildcard.json',{...base(),base:'sites.example.test',ready:true,domains:[{name:'*.sites.example.test',verified:true}],dnsProbe:{addresses:['192.0.2.10']},tlsProbe:{authorized:true}});
 return {directory,write,audit,options:{directory,expected,baseDomain:'sites.example.test'},cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('complete version-bound OTP/renderer/reconciliation/wildcard evidence approves only predeploy',()=>{
 const f=evidence();try{const result=evaluateEvidence(f.options);assert.equal(result.approved,true);assert.equal(result.files.length,10);assert.throws(()=>evaluateEvidence({...f.options,stage:'activate'}),/ENOENT/);}finally{f.cleanup();}
});
test('stale, placeholder, failed and missing-cleanup reports cannot satisfy release approval',()=>{
 const f=evidence();try{
  for(const change of [{source:'fixture'},{passed:false},{cleanup:false},{expectedOtp:false},{releases:{frontend:{gitSha:'c'.repeat(40)},backend:releases.backend}}]) {
   const path='otp-enabled/clean.json';const original=JSON.parse(readFileSync(join(f.directory,path)));f.write(path,{...original,...change});assert.throws(()=>evaluateEvidence(f.options));f.write(path,original);
  }
  assert.throws(()=>validateFreshReport({...base(),startedAt:'2020-01-01T00:00:00Z',finishedAt:'2020-01-01T00:01:00Z'},'old'),/last 24/);
  assert.throws(()=>validateFreshReport({schemaVersion:1,status:'NOT_RUN'},'none'),/complete/);
 }finally{f.cleanup();}
});
test('empty CI databases, incomplete inventory and unreviewed warning reports block production',()=>{
 const f=evidence();try{
  f.write('reconciliation.json',{...f.audit,websites:{total:0,scanned:0}});assert.throws(()=>evaluateEvidence(f.options),/Empty CI/);
  f.write('reconciliation.json',{...f.audit,websites:{total:2,scanned:1}});assert.throws(()=>evaluateEvidence(f.options),/partial/);
  f.write('reconciliation.json',{...f.audit,summary:{errors:0,warnings:1}});assert.throws(()=>evaluateEvidence(f.options),/Review reconciliation/);
  const reviewDigest=createHash('sha256').update(readFileSync(join(f.directory,'reconciliation.json'))).digest('hex');
  assert.equal(evaluateEvidence({...f.options,reviewDigest}).approved,true);
  f.write('reconciliation.json',{...f.audit,summary:{errors:1,warnings:0}});assert.throws(()=>evaluateEvidence({...f.options,reviewDigest}),/errors/);
 }finally{f.cleanup();}
});
test('custom-domain evidence is required only when enabled; default activation additionally needs a production canary',()=>{
 const f=evidence();try{
  assert.throws(()=>evaluateEvidence({...f.options,customDomains:true}),/ENOENT/);
  f.write('production-canary.json',{...base(),source:'live-read-only',baseDomain:'sites.example.test',tenants:[{state:'live',passed:true},{state:'suspended',passed:true}]});
  assert.equal(evaluateEvidence({...f.options,stage:'activate'}).approved,true);
 }finally{f.cleanup();}
});
const cohort=()=>[
 {tenant:'canary-live',websiteId:'00000000-0000-4000-8000-000000000001',state:'live',revision:4,publicUrl:'https://canary-live.sites.example.test/'},
 {tenant:'canary-denied',websiteId:'00000000-0000-4000-8000-000000000002',state:'suspended',publicUrl:'https://canary-denied.sites.example.test/'},
];
const canaryOptions=()=>({frontend:'https://app.example.test',api:'https://api.example.test',baseDomain:'sites.example.test',expected,cohort:cohort()});
function canaryFetch({leak=false,wrongRevision=false}={}) {
 const calls=[];
 const request=async(raw,options)=>{
  const url=String(raw);calls.push({url,options});
  if(url.endsWith('/api/version'))return Response.json(releases.frontend);
  if(url.endsWith('/version'))return Response.json(releases.backend);
  const item=url.includes('denied')||url.includes(cohort()[1].websiteId)?cohort()[1]:cohort()[0];
  if(item.state!=='live')return new Response(leak?'<div data-website-id="leaked"></div>':'unavailable',{status:leak?200:503,headers:{'cache-control':'no-store'}});
  if(url.includes('/by-id/')) return Response.json({data:{website:{id:item.websiteId,publishedRevisionNumber:wrongRevision?999:item.revision}}});
  return new Response(`<div data-website-id="${item.websiteId}" data-website-publication-revision="${item.revision}"></div>`,{headers:{'cache-control':'private, no-store'}});
 };return {request,calls};
}
test('small canary exercises canonical/app routes cold/warm and public by-id without writes',async()=>{
 const f=canaryFetch();const report=await runCanary(canaryOptions(),f.request);assert.equal(report.passed,true);assert.equal(f.calls.length,12);
 assert.ok(f.calls.every(c=>!c.options.method||c.options.method==='GET'));assert.ok(report.tenants.every(t=>t.checks.length===4));
});
test('canary fails for a denied website exposed as live or a mismatched committed revision',async()=>{
 for(const option of [{leak:true},{wrongRevision:true}]){const f=canaryFetch(option);assert.equal((await runCanary(canaryOptions(),f.request)).passed,false);}
});
test('cohort validation cannot silently expand to unrelated hosts, duplicate tenants or a large rollout',()=>{
 assert.throws(()=>validateCohort(cohort().map((t,i)=>i? t:{...t,publicUrl:'https://unrelated.example.test/'}),'sites.example.test'),/canonical platform/);
 assert.throws(()=>validateCohort([cohort()[0],cohort()[0]],'sites.example.test'),/Duplicate/);
 assert.throws(()=>validateCohort([...cohort(),...cohort(),...cohort()],'sites.example.test'),/two to five/);
});
test('source qualification removes ALL staging E2E variables, not just a historical allowlist',()=>{
 const helper=resolve('scripts/release/withoutE2E.mjs');
 const result=spawnSync(process.execPath,[helper,process.execPath,'-e','console.log(JSON.stringify({present:Object.keys(process.env).filter(k=>k.startsWith("E2E_")),kept:process.env.PHASE6_TEST_KEEP}))'],{encoding:'utf8',env:{...process.env,E2E_A_FUTURE_KEY:'fixture-secret',PHASE6_TEST_KEEP:'ok'}});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{present:[],kept:'ok'});
});

test('missing interface viewport or incomplete service catalog evidence blocks release',()=>{
 const f=evidence();try{
  const name='interface/interface-evidence.json';const original=JSON.parse(readFileSync(join(f.directory,name)));
  f.write(name,{...original,viewports:original.viewports.slice(1)});assert.throws(()=>evaluateEvidence(f.options),/phone\/tablet\/desktop/);
  f.write(name,{...original,checks:{...original.checks,completeCatalogRowsRetained:100}});assert.throws(()=>evaluateEvidence(f.options),/above the UI page limit/);
 }finally{f.cleanup();}
});
