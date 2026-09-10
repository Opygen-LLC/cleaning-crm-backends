-- Phase 3: drop legacy cloudinary columns and create migration tracking ledger
ALTER TABLE "job_attachment" DROP COLUMN IF EXISTS "cloudinaryId";

ALTER TABLE "BillingHistory" ADD COLUMN IF NOT EXISTS "invoiceMediaAssetId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "BillingHistory_invoiceMediaAssetId_key" ON "BillingHistory"("invoiceMediaAssetId");

ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "invoiceMediaAssetId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "payment_invoiceMediaAssetId_key" ON "payment"("invoiceMediaAssetId");

CREATE TABLE IF NOT EXISTS "legacy_media_migration" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "sourceUrlHash" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "targetMediaAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "migratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legacy_media_migration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "legacy_media_migration_adminId_sourceUrlHash_purpose_key" ON "legacy_media_migration"("adminId", "sourceUrlHash", "purpose");
CREATE INDEX IF NOT EXISTS "legacy_media_migration_adminId_status_updatedAt_idx" ON "legacy_media_migration"("adminId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "legacy_media_migration_status_updatedAt_idx" ON "legacy_media_migration"("status", "updatedAt");

ALTER TABLE "legacy_media_migration" ADD CONSTRAINT "legacy_media_migration_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
