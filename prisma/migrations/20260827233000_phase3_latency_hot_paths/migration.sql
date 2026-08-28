-- Phase 3: latency hot paths. Forward-only and data preserving.

-- Persist the latest draft revision on the owning website row so Studio reads
-- do not need a second MAX(revisionNumber) query.
ALTER TABLE "business_website"
  ADD COLUMN IF NOT EXISTS "draftRevisionNumber" INTEGER NOT NULL DEFAULT 0;

UPDATE "business_website" AS website
SET "draftRevisionNumber" = COALESCE((
  SELECT MAX(revision."revisionNumber")
  FROM "website_revision" AS revision
  WHERE revision."websiteId" = website.id
), 0);

-- Tenant-scoped newest-first/keyset indexes used by the highest-volume CRM lists.
CREATE INDEX IF NOT EXISTS "client_adminId_createdAt_id_idx"
  ON "client" ("adminId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "client_adminId_status_createdAt_id_idx"
  ON "client" ("adminId", "status", "createdAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "review_adminId_createdAt_id_idx"
  ON "review" ("adminId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "review_adminId_status_createdAt_id_idx"
  ON "review" ("adminId", "status", "createdAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "invoice_adminId_createdAt_id_idx"
  ON "invoice" ("adminId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "invoice_adminId_status_createdAt_id_idx"
  ON "invoice" ("adminId", "status", "createdAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "payment_adminId_status_paidAt_createdAt_idx"
  ON "payment" ("adminId", "status", "paidAt" DESC, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "booking_adminId_scheduledDate_id_idx"
  ON "booking" ("adminId", "scheduledDate" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "booking_adminId_status_scheduledDate_id_idx"
  ON "booking" ("adminId", "status", "scheduledDate" DESC, "id" DESC);

DROP INDEX IF EXISTS "job_adminId_createdAt_idx";
CREATE INDEX IF NOT EXISTS "job_adminId_createdAt_id_idx"
  ON "job" ("adminId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "job_adminId_scheduledDate_id_idx"
  ON "job" ("adminId", "scheduledDate" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "job_adminId_status_scheduledDate_id_idx"
  ON "job" ("adminId", "status", "scheduledDate" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "lead_adminId_createdAt_id_idx"
  ON "lead" ("adminId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "lead_adminId_stage_createdAt_id_idx"
  ON "lead" ("adminId", "stage", "createdAt" DESC, "id" DESC);
