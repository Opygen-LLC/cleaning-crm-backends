-- Phase 3: one lossless Website Submissions inbox for CONTACT / BOOKING / ESTIMATE.
-- Existing native BookingFormSubmission and EstimateFormSubmission records remain
-- authoritative for their workflows; this table is the acquisition envelope.

DO $$ BEGIN
  CREATE TYPE "WebsiteSubmissionKind" AS ENUM ('CONTACT', 'BOOKING', 'ESTIMATE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WebsiteSubmissionStatus" AS ENUM ('NEW', 'REVIEWED', 'CONVERTED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "website_submission" (
  "id" TEXT NOT NULL,
  "ref" TEXT NOT NULL,
  "kind" "WebsiteSubmissionKind" NOT NULL,
  "status" "WebsiteSubmissionStatus" NOT NULL DEFAULT 'NEW',
  "adminId" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "serviceCatalogId" TEXT,
  "serviceNameSnapshot" TEXT,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "summary" TEXT NOT NULL,
  "leadId" TEXT,
  "bookingFormSubmissionId" TEXT,
  "estimateFormSubmissionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "website_submission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "website_submission_ref_key" ON "website_submission"("ref");
CREATE UNIQUE INDEX IF NOT EXISTS "website_submission_bookingFormSubmissionId_key" ON "website_submission"("bookingFormSubmissionId");
CREATE UNIQUE INDEX IF NOT EXISTS "website_submission_estimateFormSubmissionId_key" ON "website_submission"("estimateFormSubmissionId");
CREATE INDEX IF NOT EXISTS "website_submission_adminId_createdAt_id_idx" ON "website_submission"("adminId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "website_submission_adminId_kind_createdAt_id_idx" ON "website_submission"("adminId", "kind", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "website_submission_adminId_status_createdAt_id_idx" ON "website_submission"("adminId", "status", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "website_submission_websiteId_createdAt_idx" ON "website_submission"("websiteId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "website_submission_serviceCatalogId_createdAt_idx" ON "website_submission"("serviceCatalogId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "website_submission_leadId_createdAt_idx" ON "website_submission"("leadId", "createdAt" DESC);

DO $$ BEGIN
  ALTER TABLE "website_submission" ADD CONSTRAINT "website_submission_kind_relation_check" CHECK (
    ("kind" = 'CONTACT'::"WebsiteSubmissionKind" AND "bookingFormSubmissionId" IS NULL AND "estimateFormSubmissionId" IS NULL) OR
    ("kind" = 'BOOKING'::"WebsiteSubmissionKind" AND "estimateFormSubmissionId" IS NULL) OR
    ("kind" = 'ESTIMATE'::"WebsiteSubmissionKind" AND "bookingFormSubmissionId" IS NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "website_submission" ADD CONSTRAINT "website_submission_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "website_submission" ADD CONSTRAINT "website_submission_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "business_website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "website_submission" ADD CONSTRAINT "website_submission_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "website_submission" ADD CONSTRAINT "website_submission_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "website_submission" ADD CONSTRAINT "website_submission_bookingFormSubmissionId_fkey" FOREIGN KEY ("bookingFormSubmissionId") REFERENCES "booking_form_submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "website_submission" ADD CONSTRAINT "website_submission_estimateFormSubmissionId_fkey" FOREIGN KEY ("estimateFormSubmissionId") REFERENCES "estimate_form_submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reliable historical BOOKING backfill. One native submission = one envelope.
INSERT INTO "website_submission" (
  "id", "ref", "kind", "status", "adminId", "websiteId", "serviceCatalogId",
  "serviceNameSnapshot", "name", "email", "phone", "summary",
  "bookingFormSubmissionId", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'WS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)),
  'BOOKING'::"WebsiteSubmissionKind",
  CASE b."status"::text
    WHEN 'CONVERTED' THEN 'CONVERTED'::"WebsiteSubmissionStatus"
    WHEN 'REVIEWED' THEN 'REVIEWED'::"WebsiteSubmissionStatus"
    WHEN 'DECLINED' THEN 'DISMISSED'::"WebsiteSubmissionStatus"
    ELSE 'NEW'::"WebsiteSubmissionStatus"
  END,
  f."adminId",
  b."sourceWebsiteId",
  b."serviceCatalogId",
  b."serviceNameSnapshot",
  b."name",
  lower(b."email"),
  b."phone",
  COALESCE(NULLIF(btrim(b."notes"), ''), 'Booking request for ' || COALESCE(b."serviceNameSnapshot", 'service')),
  b."id",
  b."createdAt",
  b."createdAt"
FROM "booking_form_submission" b
JOIN "booking_form" f ON f."id" = b."formId"
JOIN "business_website" w ON w."id" = b."sourceWebsiteId" AND w."adminId" = f."adminId"
WHERE b."sourceWebsiteId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "website_submission" ws WHERE ws."bookingFormSubmissionId" = b."id");

-- Reliable historical ESTIMATE backfill.
INSERT INTO "website_submission" (
  "id", "ref", "kind", "status", "adminId", "websiteId", "serviceCatalogId",
  "serviceNameSnapshot", "name", "email", "phone", "summary",
  "estimateFormSubmissionId", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'WS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)),
  'ESTIMATE'::"WebsiteSubmissionKind",
  CASE e."status"::text
    WHEN 'CONVERTED' THEN 'CONVERTED'::"WebsiteSubmissionStatus"
    WHEN 'QUOTED' THEN 'REVIEWED'::"WebsiteSubmissionStatus"
    WHEN 'DISMISSED' THEN 'DISMISSED'::"WebsiteSubmissionStatus"
    ELSE 'NEW'::"WebsiteSubmissionStatus"
  END,
  f."adminId",
  e."sourceWebsiteId",
  e."serviceCatalogId",
  e."serviceNameSnapshot",
  e."name",
  lower(e."email"),
  e."phone",
  COALESCE(NULLIF(btrim(e."notes"), ''), 'Estimate request for ' || COALESCE(e."serviceNameSnapshot", 'service')),
  e."id",
  e."createdAt",
  e."createdAt"
FROM "estimate_form_submission" e
JOIN "estimate_form" f ON f."id" = e."formId"
JOIN "business_website" w ON w."id" = e."sourceWebsiteId" AND w."adminId" = f."adminId"
WHERE e."sourceWebsiteId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "website_submission" ws WHERE ws."estimateFormSubmissionId" = e."id");

-- Best-effort CONTACT history. Old code deduplicated repeat contacts into one
-- Lead + appended notes, so individual historical events cannot be recovered.
-- Create one envelope per website-attributed Lead without inventing events.
INSERT INTO "website_submission" (
  "id", "ref", "kind", "status", "adminId", "websiteId", "serviceCatalogId",
  "serviceNameSnapshot", "name", "email", "phone", "summary", "leadId",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  'WS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)),
  'CONTACT'::"WebsiteSubmissionKind",
  CASE WHEN l."convertedClientId" IS NOT NULL THEN 'CONVERTED'::"WebsiteSubmissionStatus" ELSE 'REVIEWED'::"WebsiteSubmissionStatus" END,
  l."adminId",
  l."sourceWebsiteId",
  l."serviceCatalogId",
  l."serviceInterest",
  l."name",
  lower(l."email"),
  l."phone",
  COALESCE(NULLIF(btrim(l."notes"), ''), 'Historical website contact'),
  l."id",
  l."createdAt",
  l."updatedAt"
FROM "lead" l
JOIN "business_website" w ON w."id" = l."sourceWebsiteId" AND w."adminId" = l."adminId"
WHERE l."sourceWebsiteId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "website_submission" ws
    WHERE ws."kind" = 'CONTACT'::"WebsiteSubmissionKind" AND ws."leadId" = l."id"
  );
