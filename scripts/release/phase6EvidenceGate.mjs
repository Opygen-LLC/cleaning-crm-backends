#!/usr/bin/env node
/** Read-only release approval gate. Missing, stale, fixture or partial evidence fails. */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export function validateFreshReport(report, name, now = Date.now()) {
  const start = Date.parse(report?.startedAt), end = Date.parse(report?.finishedAt);
  requireValue(report?.schemaVersion === 1 && Number.isFinite(start) && Number.isFinite(end) &&
    start <= end && start >= now - 24 * 60 * 60 * 1000 && end <= now + 60000,
    `${name}: require a complete report from the last 24 hours, not a placeholder`);
}
export function validateReleases(report, expected, name) {
  for (const service of ['frontend', 'backend']) requireValue(
    report?.releases?.[service]?.gitSha?.toLowerCase() === expected[service].toLowerCase(),
    `${name}: deployed ${service} release identity does not match the candidate`);
  requireValue(report.source === 'live-staging' && report.passed === true && report.cleanup === true,
    `${name}: require successful real staging execution and confirmed cleanup`);
}
export function evaluateEvidence({ directory, expected, baseDomain, stage = 'predeploy', reviewDigest, customDomains = false, now = Date.now() }) {
  requireValue(['predeploy','activate'].includes(stage), 'Stage must be predeploy or activate');
  for (const service of ['frontend','backend']) requireValue(/^[a-f0-9]{40,64}$/i.test(expected?.[service] ?? ''), `Require full ${service} candidate commit SHA`);
  requireValue(typeof baseDomain === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(baseDomain), 'WEBSITE_BASE_DOMAIN is required');
  const files = [];
  const read = name => {
    const path = resolve(directory, name);
    requireValue(statSync(path).size <= 20 * 1024 * 1024, `${name}: report exceeds 20 MiB`);
    const bytes = readFileSync(path), report = JSON.parse(bytes.toString('utf8'));
    validateFreshReport(report, name, now);
    files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') });
    return report;
  };
  for (const [folder, otp] of [['otp-enabled',true],['otp-disabled',false]]) {
    for (const scenario of ['clean','lost-response-retry']) {
      const name=`${folder}/${scenario}.json`, report=read(name);
      validateReleases(report, expected, name);
      requireValue(report.scenario === scenario && report.expectedOtp === otp, `${name}: wrong OTP/scenario evidence`);
      for(const check of ['savedFieldsRoundTrip','cachedDraftPrimed','unpublishedForgeryDenied','firstCanonicalWebsiteAndRevision','liveForgeryCannotChangeIdentity','repeatCreatesNoRevision']) {
        requireValue(report.checks?.[check] === true, `${name}: missing ${check}`);
      }
      requireValue(report.checks?.dashboardNavigations === 1, `${name}: completion must navigate exactly once`);
      requireValue(report.firstCanonicalRequest?.status === 200, `${name}: canonical first visit failed`);
    }
  }
  const interfaceReport = read('interface/interface-evidence.json');
  validateReleases(interfaceReport, expected, 'interface/interface-evidence.json');
  for (const check of ['localPreviewWithoutKeystrokeRequests', 'inlineErrorAndFailedSavePreserveInput', 'savedBrandingReloadAndAccessibleNames', 'reviewRequiresExplicitLaunch']) {
    requireValue(interfaceReport.checks?.[check] === true, `Interface evidence: missing ${check}`);
  }
  requireValue(Number.isSafeInteger(interfaceReport.checks?.completeCatalogRowsRetained) && interfaceReport.checks.completeCatalogRowsRetained >= 101, 'Interface evidence must retain a complete catalog above the UI page limit');
  requireValue([390,768,1440].every(width => interfaceReport.viewports?.some(v => v.width === width && v.overflow === false && v.unlabeled?.length === 0 && v.primaryCount === 1)), 'Interface evidence needs phone/tablet/desktop labels and stable geometry');
  const studioReports = ['studio/studio-1.0.0.json','studio/studio-2.0.0.json', ...(customDomains ? ['studio/studio-2.0.0-custom.json'] : [])];
  for(const name of studioReports) {
    const report=read(name); validateReleases(report,expected,name);
    const version=name.includes('1.0.0') ? '1.0.0' : '2.0.0';
    requireValue(report.suite === 'website-studio' && report.templateVersion === version, `${name}: wrong renderer version`);
    requireValue(['clean-modern','premium-home','commercial-pro','local-cleaning'].every(id=>report.checks?.templates?.includes(id)), `${name}: incomplete template matrix`);
    for(const check of ['immediatePublish','rapidSelection','trailingSave','immediatePublicRevision']) requireValue(report.checks?.[check] === true,`${name}: missing ${check}`);
    if(name.includes('-custom')) requireValue(report.checks.customDomain === true, `${name}: custom domain was not exercised`);
  }
  const audit=read('reconciliation.json');
  requireValue(audit.source === 'database-snapshot' && audit.mode === 'read-only' && audit.readOnly === true && audit.isolation === 'repeatable read' && audit.complete === true,
    'Reconciliation must be a complete read-only database snapshot');
  requireValue(audit.sourceRevision?.toLowerCase() === expected.backend.toLowerCase(), 'Reconciliation was not run from the backend candidate');
  requireValue(Number.isSafeInteger(audit.websites?.total) && audit.websites.total > 0 && audit.websites.total === audit.websites.scanned,
    'Empty CI databases and partial inventory scans are not production reconciliation evidence');
  requireValue(audit.safeToProceed === true && audit.summary?.errors === 0, 'Reconciliation errors must be reviewed and repaired separately before rollout');
  if (audit.summary.warnings > 0) requireValue(reviewDigest === files.at(-1).sha256,
    'Review reconciliation warnings and set RELEASE_RECONCILIATION_REVIEW_SHA256 to the exact reviewed report digest');
  const wildcard=read('platform-wildcard.json');
  requireValue(wildcard.base === baseDomain.toLowerCase() && wildcard.ready === true && wildcard.tlsProbe?.authorized === true && wildcard.dnsProbe?.addresses?.length > 0,
    'Platform wildcard DNS/TLS is not confirmed for this base domain');
  requireValue(wildcard.domains?.some(d=>d.name === `*.${baseDomain.toLowerCase()}` && d.verified === true), 'Verified platform wildcard assignment is missing');
  if (stage === 'activate') {
    const canary=read('production-canary.json');
    requireValue(canary.source === 'live-read-only' && canary.passed === true && canary.baseDomain === baseDomain.toLowerCase(), 'Post-deploy canary must pass before default activation');
    for(const service of ['frontend','backend']) requireValue(canary.releases?.[service]?.gitSha?.toLowerCase() === expected[service].toLowerCase(), `Canary ${service} is not the candidate`);
    requireValue(Array.isArray(canary.tenants) && canary.tenants.length >= 2 && canary.tenants.length <= 5 &&
      canary.tenants.some(t=>t.state === 'live') && canary.tenants.some(t=>t.state !== 'live') &&
      canary.tenants.every(t=>t.passed === true), 'Canary needs a small live and denied tenant cohort, including canonical and app-host checks');
  }
  return { schemaVersion:1, stage, approved:true, checkedAt:new Date(now).toISOString(), expected, files,
    note:'Approval does not deploy, repair data, change a template default or replace production monitoring.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args=process.argv.slice(2);
    requireValue(args.length <= 1 && (!args[0] || /^--stage=(predeploy|activate)$/.test(args[0])), 'Usage: phase6EvidenceGate.mjs [--stage=predeploy|activate]');
    requireValue(process.env.RELEASE_EVIDENCE_DIR, 'RELEASE_EVIDENCE_DIR is required');
    const result=evaluateEvidence({directory:process.env.RELEASE_EVIDENCE_DIR,
      expected:{frontend:process.env.RELEASE_FRONTEND_SHA,backend:process.env.RELEASE_BACKEND_SHA},
      baseDomain:process.env.WEBSITE_BASE_DOMAIN,stage:args[0]?.split('=')[1] ?? 'predeploy',
      reviewDigest:process.env.RELEASE_RECONCILIATION_REVIEW_SHA256,customDomains:process.env.WEBSITE_CUSTOM_DOMAINS_ENABLED === 'true'});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } catch(error) { console.error(`Phase 6 release BLOCKED: ${error.message}`);process.exitCode=1; }
}
