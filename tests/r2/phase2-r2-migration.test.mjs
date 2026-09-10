import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

function filesUnder(dir) {
  const absolute = join(root, dir);
  const out = [];
  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(relative(root, path)));
    else out.push(path);
  }
  return out;
}

test('Phase 2 domain upload code has no Cloudinary write calls', () => {
  const moduleText = filesUnder('src/modules')
    .filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\./.test(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  assert.doesNotMatch(moduleText, /\buploadFileToCloudinary\b/);
  assert.doesNotMatch(moduleText, /\buploadToCloudinary\b/);
  assert.doesNotMatch(moduleText, /cloudinaryUpload\.(?:uploader|api|url)/);
});

test('central media service owns tenant paths and private direct-upload finalization', () => {
  const service = read('src/modules/Media/media.service.ts');
  const keys = read('src/modules/Media/mediaKeyBuilder.ts');
  const routes = read('src/modules/Media/media.routes.ts');
  const validation = read('src/modules/Media/media.validation.ts');

  assert.match(keys, /\["organizations", safeSegment\(params\.adminId\), policy\.prefix\]/);
  assert.match(keys, /JOB_PHOTO/);
  assert.match(keys, /PAYMENT_RECEIPT/);
  assert.match(service, /R2_PRIVATE_BUCKET, asset\.temporaryObjectKey/);
  assert.match(service, /downloadAndOptimizeR2Image/);
  assert.match(service, /status: "READY"/);
  assert.match(service, /createPrivateReadUrl/);
  assert.match(routes, /\/uploads\/initiate/);
  assert.match(routes, /\/uploads\/:uploadId\/complete/);
  assert.doesNotMatch(validation, /\bfolder\s*:/);
});

test('all requested Phase 2 purposes are represented by the media policy', () => {
  const types = read('src/modules/Media/media.types.ts');
  const required = [
    'USER_AVATAR', 'STAFF_AVATAR', 'BUSINESS_LOGO', 'BUSINESS_FAVICON',
    'SERVICE_IMAGE', 'WEBSITE_BRAND', 'WEBSITE_CONTENT', 'JOB_PHOTO',
    'JOB_ATTACHMENT', 'PAYMENT_PROOF', 'PAYMENT_RECEIPT', 'INVOICE_ATTACHMENT',
    'EXPENSE_RECEIPT', 'SUBSCRIPTION_PROOF',
  ];
  for (const purpose of required) assert.match(types, new RegExp(`"${purpose}"`));
});

test('domain records persist authoritative MediaAsset references', () => {
  const schemaChecks = {
    'prisma/schema/auth.prisma': 'imageMediaAssetId',
    'prisma/schema/admin.prisma': 'businessLogoMediaAssetId',
    'prisma/schema/jobNote.prisma': 'mediaAssetId',
    'prisma/schema/payment.prisma': 'paymentProofMediaAssetId',
    'prisma/schema/expense.prisma': 'receiptMediaAssetId',
    'prisma/schema/billing.prisma': 'paymentProofMediaAssetId',
    'prisma/schema/website.prisma': 'mediaAssetId',
  };
  for (const [path, field] of Object.entries(schemaChecks)) assert.match(read(path), new RegExp(`\\b${field}\\b`));

  const migration = read('prisma/migrations/20260910193000_r2_phase2_domain_media_references/migration.sql');
  for (const field of Object.values(schemaChecks)) assert.match(migration, new RegExp(field));
});

test('sensitive feature flows bind or create R2 MediaAssets', () => {
  assert.match(read('src/modules/Invoice/invoice.service.ts'), /"PAYMENT_PROOF"/);
  assert.match(read('src/modules/Payment/payment.service.ts'), /"PAYMENT_RECEIPT"/);
  assert.match(read('src/modules/Expense/expense.service.ts'), /"EXPENSE_RECEIPT"/);
  assert.match(read('src/modules/Subscription/subscription.service.ts'), /"SUBSCRIPTION_PROOF"/);
  assert.match(read('src/modules/Job/job.notes.service.ts'), /"JOB_(?:PHOTO|ATTACHMENT)"/);
  assert.match(read('src/modules/Website/websiteAsset.service.ts'), /provider: "r2"/);
  assert.match(read('src/modules/Website/website.service.ts'), /mediaAssetId/);
});

test('private R2 records are converted to signed read URLs before API presentation', () => {
  assert.match(read('src/modules/Invoice/invoice.service.ts'), /getReadUrlForTenant/);
  assert.match(read('src/modules/Payment/payment.service.ts'), /getReadUrlForTenant/);
  assert.match(read('src/modules/Expense/expense.service.ts'), /getReadUrlForTenant/);
  assert.match(read('src/modules/Subscription/subscription.service.ts'), /getReadUrlForTenant/);
  assert.match(read('src/modules/SuperAdmin/superAdmin.service.ts'), /getReadUrlForTenant/);
});

test('tenant reads ignore forged organization filters outside SUPER_ADMIN', () => {
  const expense = read('src/modules/Expense/expense.service.ts');
  const invoice = read('src/modules/Invoice/invoice.service.ts');
  assert.match(expense, /user\.role === UserRole\.SUPER_ADMIN/);
  assert.match(expense, /adminId: await getAdminId\(user\)/);
  assert.match(invoice, /user\.role === UserRole\.SUPER_ADMIN/);
  assert.match(invoice, /resolvedAdminId = await getAdminId\(user\)/);
});

test('generic media deletion refuses assets still referenced by domain rows', () => {
  const service = read('src/modules/Media/media.service.ts');
  assert.match(service, /assertAssetNotInUse/);
  assert.match(service, /MEDIA_ASSET_IN_USE/);
  assert.match(service, /paymentProofMediaAssetId/);
  assert.match(service, /receiptMediaAssetId/);
  assert.match(service, /websiteAsset\.findFirst/);
  assert.match(service, /deleteAssetIfUnreferencedForTenant/);
});

test('finalize failures only release the exact processing lease they acquired', () => {
  const service = read('src/modules/Media/media.service.ts');
  assert.match(service, /processingLeaseUpdatedAt/);
  assert.match(service, /status: "PROCESSING", updatedAt: processingLeaseUpdatedAt/);
  assert.match(service, /acquireImageSlot/);
  assert.match(service, /releaseImageSlot/);
});

test('client portal payment proof uses invoice-scoped presigned R2 sessions', () => {
  const routes = read('src/modules/Invoice/invoice.routes.ts');
  const service = read('src/modules/Invoice/invoice.service.ts');
  assert.match(routes, /proof\/uploads\/initiate/);
  assert.match(routes, /proof\/uploads\/:uploadId\/complete/);
  assert.match(service, /initiateUploadForTenant/);
  assert.match(service, /finalizeUploadForTenant/);
  assert.match(service, /bindReadyAssetForTenant/);
  assert.match(service, /adminId: authCtx\.portalClient\.adminId/);
});

test('server fallback uploads clean up finalized R2 assets if domain attachment fails', () => {
  assert.match(read('src/modules/Job/job.notes.service.ts'), /deleteAssetIfUnreferencedForTenant/);
  assert.match(read('src/modules/Website/website.service.ts'), /deleteAssetIfUnreferencedForTenant/);
  assert.match(read('src/modules/Admin/admin.controller.ts'), /deleteAssetIfUnreferencedForTenant/);
});
