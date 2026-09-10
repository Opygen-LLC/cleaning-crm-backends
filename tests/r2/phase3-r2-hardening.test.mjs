import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

function filesUnder(dir) {
  const absolute = join(root, dir);
  const out = [];
  if (!existsSync(absolute)) return out;
  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(relative(root, path)));
    else out.push(path);
  }
  return out;
}

test('Cloudinary runtime dependency, config, and middleware are removed', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies?.cloudinary, undefined);
  assert.equal(pkg.devDependencies?.cloudinary, undefined);
  for (const path of [
    'src/config/cloudinary.ts',
    'src/config/multer.ts',
    'src/lib/utils/cloudinary.ts',
    'src/middlewares/fileUpload.middleware.ts',
  ]) assert.equal(existsSync(join(root, path)), false, `${path} must be deleted`);

  const runtime = filesUnder('src')
    .filter((path) => /\.(ts|tsx|js|mjs)$/.test(path))
    .filter((path) => !path.endsWith(join('Media', 'legacyMediaMigration.service.ts')))
    .filter((path) => !path.includes('.test.'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.doesNotMatch(runtime, /cloudinary/i);
  assert.doesNotMatch(read('.env.example'), /CLOUDINARY_/);
  assert.doesNotMatch(read('src/config/runtimeEnv.ts'), /CLOUDINARY_/);
});

test('production runtime requires one valid Cloudflare R2 provider', () => {
  const runtime = read('src/config/runtimeEnv.ts');
  assert.match(runtime, /STORAGE_PROVIDER:\s*z\.literal\("r2"\)/);
  for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_BUCKET', 'R2_PRIVATE_BUCKET', 'R2_ENDPOINT', 'R2_PUBLIC_BASE_URL']) {
    assert.match(runtime, new RegExp(`${key}:\\s*`));
  }
  assert.match(runtime, /r2\.cloudflarestorage\.com/);
  assert.match(runtime, /r2\\\.dev/);
  assert.match(runtime, /R2_PUBLIC_BUCKET === env\.R2_PRIVATE_BUCKET/);
});

test('legacy migration is idempotent, tenant scoped, bounded, and verifies R2', () => {
  const migration = read('src/modules/Media/legacyMediaMigration.service.ts');
  assert.match(migration, /legacyMediaMigration\.upsert/);
  assert.match(migration, /adminId_sourceUrlHash_purpose/);
  assert.match(migration, /attemptCount:\s*\{ increment: 1 \}/);
  assert.match(migration, /migrationHash\(/);
  assert.match(migration, /entityId \?\? ""/);
  assert.match(migration, /stableObjectId\(hash\)/);
  assert.match(migration, /AbortSignal\.timeout/);
  assert.match(migration, /MAX_REDIRECTS/);
  assert.match(migration, /ContentLength/);
  assert.match(migration, /headObject\(asset\.bucket, asset\.objectKey\)/);
  assert.match(migration, /status: "MIGRATED"/);
  assert.match(migration, /"MISSING"/);
  assert.match(migration, /"INVALID"/);
});

test('migration covers legacy domain fields and immutable website publication data', () => {
  const migration = read('src/modules/Media/legacyMediaMigration.service.ts');
  for (const marker of [
    'User.image', 'AdminProfile.businessLogo', 'JobAttachment.fileUrl',
    'Payment.paymentProofUrl', 'Payment.invoiceUrl',
    'BillingHistory.paymentProofUrl', 'BillingHistory.invoiceUrl',
    'Expense.receiptUrl', 'Expense.notes[RECEIPT]',
    'BusinessWebsite.', 'WebsiteAsset.', 'Website JSON snapshot/content',
    'publishedDesignMetadata', 'publishedSnapshot', 'websiteRevision',
  ]) assert.match(migration, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(migration, /WebsiteProjectionCacheService\.invalidateWebsite/);
  assert.match(migration, /remainingLegacyReferences/);
  assert.match(migration, /r2VerificationFailures/);
});

test('schema records migration state and removes provider-specific job attachment id', () => {
  assert.doesNotMatch(read('prisma/schema/jobNote.prisma'), /cloudinaryId/);
  const media = read('prisma/schema/media.prisma');
  assert.match(media, /model LegacyMediaMigration/);
  assert.match(media, /sourceUrlHash/);
  assert.match(media, /targetMediaAssetId/);
  assert.match(media, /@@unique\(\[adminId, sourceUrlHash, purpose\]\)/);
  assert.match(read('prisma/schema/payment.prisma'), /invoiceMediaAssetId/);
  assert.match(read('prisma/schema/billing.prisma'), /invoiceMediaAssetId/);
  const sql = read('prisma/migrations/20260910200000_r2_phase3_hardening/migration.sql');
  assert.match(sql, /DROP COLUMN IF EXISTS "cloudinaryId"/i);
  assert.match(sql, /legacy_media_migration/i);
});

test('tenant hard-delete purges both R2 buckets by organization prefix and temp prefix', () => {
  const tenant = read('src/modules/SuperAdmin/tenantAdmin.service.ts');
  assert.match(tenant, /organizations\/\$\{adminId\}\//);
  assert.match(tenant, /tmp\/\$\{adminId\}\//);
  assert.match(tenant, /R2_PUBLIC_BUCKET/);
  assert.match(tenant, /R2_PRIVATE_BUCKET/);
  assert.match(tenant, /deletePrefix/);
  assert.match(tenant, /R2_ASSETS/);
  assert.doesNotMatch(tenant, /deleteFileFromCloudinary|tenantCloudinaryUrls/);
});

test('R2 objects use immutable public caching, private no-store, lifecycle, and prefix deletion', () => {
  const storage = read('src/lib/storage/r2Storage.service.ts');
  assert.match(storage, /public, max-age=31536000, immutable/);
  assert.match(storage, /private, no-store/);
  assert.match(storage, /list-type/);
  assert.match(storage, /deletePrefix/);
  assert.match(storage, /putLifecycleConfiguration/);
  const lifecycle = read('docs/r2-lifecycle.phase3.xml');
  assert.match(lifecycle, /<Prefix>tmp\/<\/Prefix>/);
  assert.match(lifecycle, /<Days>1<\/Days>/);
  assert.match(lifecycle, /AbortIncompleteMultipartUpload/);
});

test('private migrated invoice/proof references are signed on every primary read path', () => {
  assert.match(read('src/modules/SuperAdmin/superAdmin.service.ts'), /resolveBillingInvoiceUrl/);
  assert.match(read('src/modules/Subscription/subscription.service.ts'), /invoiceMediaAssetId[\s\S]*getReadUrlForTenant/);
  assert.match(read('src/modules/SuperAdmin/organization360.service.ts'), /invoiceMediaAssetId[\s\S]*getReadUrlForTenant/);
  const payment = read('src/modules/Payment/payment.service.ts');
  assert.match(payment, /invoiceMediaAssetId[\s\S]*getReadUrlForTenant/);
  assert.match(payment, /deleteAssetForTenant\(existing\.invoiceMediaAssetId/);
});
