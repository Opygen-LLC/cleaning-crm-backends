#!/usr/bin/env node
/** Reads public routes only. Never creates accounts, publishes or changes tenant state. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const requireValue=(ok,message)=>{if(!ok)throw new Error(message);};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function origin(raw,name) {
  const url=new URL(raw);
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', `${name} must be an HTTPS origin`);
  return url.origin;
}
export function validateCohort(value, baseDomain) {
  requireValue(Array.isArray(value) && value.length >= 2 && value.length <= 5,'Supply two to five canary tenants, including a live and a denied tenant');
  const seen=new Set();
  for(const item of value) {
    requireValue(uuid.test(item.websiteId ?? '') && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item.tenant ?? ''), 'Invalid canary identity');
    requireValue(['live','unpublished','suspended'].includes(item.state), 'Unknown canary state');
    requireValue(!seen.has(item.websiteId),'Duplicate canary tenant');seen.add(item.websiteId);
    requireValue(origin(item.publicUrl,'Canonical public URL') === `https://${item.tenant}.${baseDomain}`, 'Canary must use its canonical platform host; custom domains are a separate gate');
    if(item.state === 'live') requireValue(Number.isSafeInteger(item.revision) && item.revision>0,'Live canary requires an expected committed publication revision');
  }
  requireValue(value.some(t=>t.state === 'live') && value.some(t=>t.state !== 'live'),'Canary must include both permitted and denied access');
  return value;
}
async function jsonRequest(url,request) {
  const res=await request(url,{cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(15000)});
  requireValue(res.ok,`Read-only verification failed: HTTP ${res.status}`);return res.json();
}
export async function runCanary({ frontend, api, baseDomain, expected, cohort }, request=fetch) {
  frontend=origin(frontend,'Frontend');api=origin(api,'API');
  requireValue(/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(baseDomain),'Invalid base domain');
  baseDomain=baseDomain.toLowerCase();validateCohort(cohort,baseDomain);
  const report={schemaVersion:1,source:'live-read-only',startedAt:new Date().toISOString(),finishedAt:null,baseDomain,releases:{},tenants:[],passed:false};
  try {
    for(const [service,url] of [['frontend',`${frontend}/api/version`],['backend',`${api}/version`]]) {
      requireValue(/^[a-f0-9]{40,64}$/i.test(expected[service] ?? ''),'Require full candidate commit SHAs');
      const version=await jsonRequest(url,request);requireValue(version.gitSha?.toLowerCase() === expected[service].toLowerCase(),`${service} is not the candidate release`);
      report.releases[service]={gitSha:version.gitSha,version:version.version,buildDate:version.buildDate};
    }
    for(const item of cohort) {
      const result={websiteId:item.websiteId,tenant:item.tenant,state:item.state,revision:item.revision ?? null,checks:[],passed:false};report.tenants.push(result);
      const forged={'x-website-id':'00000000-0000-4000-8000-000000000099','x-website-availability':'live','x-website-publication-revision':'999999','x-website-public-document':'document','x-website-route-proof':'forged.proof','x-middleware-subrequest':'src/proxy:proxy:middleware','x-matched-path':'/site/forged'};
      for(const [surface,url] of [['canonical',item.publicUrl],['app-internal',`${frontend}/site/${encodeURIComponent(item.tenant)}`]]) {
        for(const warm of [false,true]) {
          const res=await request(url,{headers:forged,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(20000)});
          const body=await res.text();const expectedStatus=item.state === 'live' ? 200 : item.state === 'suspended' ? 503 : 404;
          requireValue(res.status === expectedStatus,`${surface}: unexpected canary status ${res.status}`);
          requireValue(/no-store/i.test(res.headers.get('cache-control') ?? ''),`${surface}: shared cache bypass is possible`);
          if(item.state === 'live') {
            requireValue(body.includes(`data-website-id="${item.websiteId}"`) && body.includes(`data-website-publication-revision="${item.revision}"`),`${surface}: canonical identity or revision mismatch`);
          } else requireValue(!body.includes('data-website-id="'),`${surface}: denied tenant rendered a website`);
          result.checks.push({surface,warm,status:res.status,identityVerified:item.state === 'live',requestId:res.headers.get('x-request-id')});
        }
      }
      const response=await request(`${api}/api/v1/website/public/by-id/${item.websiteId}`,{headers:forged,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(20000)});
      if(item.state === 'live') {
        requireValue(response.status === 200,'Public by-id route failed');
        const raw=await response.json(), data=raw?.data ?? raw;
        requireValue(data.website?.id === item.websiteId && data.website?.publishedRevisionNumber === item.revision,'Public by-id identity/revision mismatch');
      } else requireValue([403,404,503].includes(response.status),'Public by-id route bypassed suspension/publication');
      result.passed=true;
    }
    report.passed=true;
  } catch(error) { report.failure=error.message; }
  report.finishedAt=new Date().toISOString();return report;
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireValue(process.env.RELEASE_CANARY_COHORT,'RELEASE_CANARY_COHORT must name an approved JSON cohort file');
    const report=await runCanary({frontend:process.env.PRODUCTION_FRONTEND_URL,api:process.env.PRODUCTION_API_ORIGIN,
      baseDomain:process.env.WEBSITE_BASE_DOMAIN,expected:{frontend:process.env.RELEASE_FRONTEND_SHA,backend:process.env.RELEASE_BACKEND_SHA},
      cohort:JSON.parse(readFileSync(process.env.RELEASE_CANARY_COHORT,'utf8'))});
    const output=resolve(process.env.RELEASE_EVIDENCE_DIR ?? 'artifacts/phase6','production-canary.json');
    mkdirSync(dirname(output),{recursive:true,mode:0o700});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(`Read-only canary ${report.passed?'PASS':'FAIL'}: ${output}`);if(!report.passed) process.exitCode=1;
  } catch(error) { console.error(`Canary BLOCKED: ${error.message}`);process.exitCode=1; }
}
