BEGIN;

CREATE TABLE "media_asset" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "bucket" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "temporaryObjectKey" TEXT,
  "purpose" TEXT NOT NULL,
  "visibility" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "originalFilename" TEXT NOT NULL,
  "originalMimeType" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "originalBytes" INTEGER NOT NULL,
  "storedBytes" INTEGER,
  "width" INTEGER,
  "height" INTEGER,
  "checksum" TEXT,
  "etag" TEXT,
  "publicUrl" TEXT,
  "variants" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'INITIATED',
  "expiresAt" TIMESTAMP(3),
  "finalizedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_asset_objectKey_key" ON "media_asset"("objectKey");
CREATE UNIQUE INDEX "media_asset_temporaryObjectKey_key" ON "media_asset"("temporaryObjectKey");
CREATE INDEX "media_asset_adminId_createdAt_idx" ON "media_asset"("adminId", "createdAt" DESC);
CREATE INDEX "media_asset_adminId_purpose_createdAt_idx" ON "media_asset"("adminId", "purpose", "createdAt" DESC);
CREATE INDEX "media_asset_adminId_entityType_entityId_idx" ON "media_asset"("adminId", "entityType", "entityId");
CREATE INDEX "media_asset_status_expiresAt_idx" ON "media_asset"("status", "expiresAt");

ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
