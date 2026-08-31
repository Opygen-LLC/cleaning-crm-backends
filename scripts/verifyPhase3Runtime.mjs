import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const fail = (message) => { console.error(`[phase3-runtime] FAIL: ${message}`); process.exitCode = 1; };
const requireMarker = (rel, marker) => { if (!read(rel).includes(marker)) fail(`${rel} missing ${marker}`); };

for (const [rel, markers] of Object.entries({
  'src/lib/monitoring/requestStormDetector.ts': ['CLIENT_REQUEST_LOOP_DETECTED', 'WINDOW_MS = 10_000'],
  'src/lib/monitoring/queryBudgets.ts': ['GET /api/v1/auth/session', 'POST /api/v1/auth/register', 'POST /api/v1/website/launch'],
  'src/middlewares/logger.middleware.ts': ['request_storm_detected', 'endpoint_query_budget_exceeded', 'X-DB-Query-Count'],
  'src/errorHelper/errorClassification.ts': ['AUTH_BOOTSTRAP', 'TENANT_INVARIANT', 'LIFECYCLE_CONFLICT'],
  'src/lib/utils/resolveAdminId.ts': ['TENANT_CONTEXT_RESOLUTION_FAILED'],
  'src/scripts/phase1/dataAudit.ts': ['--ci', 'runIntegrityChecks'],
  'src/scripts/integrity/integrityChecks.ts': ['ORPHANED_PRIMARY_BOOKING_FORM', 'SUBSCRIPTION_PLAN_REFERENCE_INVALID'],
  'src/contracts/endpointContract.ts': ['Auth', 'Notifications', 'Website Studio', 'Super Admin', 'TErrorResponse'],
  'src/lib/utils/resolveAdminId.tenantIsolation.test.ts': ['Admin A', 'Admin B', 'Staff A', 'Staff B', 'Super Admin'],
})) for (const marker of markers) requireMarker(rel, marker);

const productionSources = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) productionSources.push(full);
  }
};
walk(path.join(root, 'src/modules'));
for (const file of productionSources) {
  const source = fs.readFileSync(file, 'utf8');
  if (/getAdminId\(\s*\{/s.test(source) || /resolveAdminId\(\s*\{/s.test(source)) {
    fail(`${path.relative(root, file)} fabricates authenticated tenant context instead of passing IRequestUser`);
  }
}

const routeIndex = read('src/routes/index.ts');
for (const prefix of ['/auth','/admin','/client','/staff','/booking','/job','/lead','/quote','/invoice','/payment','/reports','/notification','/website','/booking-form','/estimate-form','/subscription','/super-admin']) {
  if (!routeIndex.includes(`path: "${prefix}"`)) fail(`src/routes/index.ts is missing ${prefix}`);
}

if (!process.exitCode) console.log(`[phase3-runtime] PASS: ${productionSources.length} production module files checked`);
