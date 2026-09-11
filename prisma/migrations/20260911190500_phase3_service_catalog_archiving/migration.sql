-- Phase 3: preserve referenced services when an admin removes them from the
-- current catalogue. Archived services remain available to historical records
-- but are excluded from all current-catalog read models.
ALTER TABLE "service_catalog"
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "service_catalog_adminId_archivedAt_status_idx"
  ON "service_catalog"("adminId", "archivedAt", "status");
