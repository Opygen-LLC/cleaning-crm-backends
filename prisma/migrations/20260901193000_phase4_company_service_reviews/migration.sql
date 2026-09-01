-- Phase 4: company/service website reviews and stable service slugs.
-- The migration keeps the existing job-token review workflow intact while
-- allowing moderated website reviews that are not attached to a Job.

DO $$ BEGIN
  CREATE TYPE "ReviewScope" AS ENUM ('COMPANY', 'SERVICE', 'JOB', 'STAFF');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReviewSource" AS ENUM ('WEBSITE', 'JOB_TOKEN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Stable, tenant-scoped public service slug. Add it nullable first so existing
-- rows can be deterministically backfilled without blocking the migration.
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "slug" TEXT;

DO $$
DECLARE
  service_row RECORD;
  base_slug TEXT;
  candidate TEXT;
  suffix_num INTEGER;
BEGIN
  FOR service_row IN
    SELECT "id", "adminId", "serviceName"
    FROM "service_catalog"
    WHERE "slug" IS NULL OR btrim("slug") = ''
    ORDER BY "adminId", "createdAt", "id"
  LOOP
    base_slug := lower(service_row."serviceName");
    base_slug := regexp_replace(base_slug, '[^a-z0-9]+', '-', 'g');
    base_slug := regexp_replace(base_slug, '(^-+|-+$)', '', 'g');
    base_slug := left(base_slug, 72);
    IF base_slug = '' THEN base_slug := 'service'; END IF;

    candidate := base_slug;
    suffix_num := 2;
    WHILE EXISTS (
      SELECT 1 FROM "service_catalog"
      WHERE "adminId" = service_row."adminId"
        AND "slug" = candidate
        AND "id" <> service_row."id"
    ) LOOP
      candidate := left(base_slug, GREATEST(1, 72 - length(suffix_num::text) - 1)) || '-' || suffix_num::text;
      suffix_num := suffix_num + 1;
    END LOOP;

    UPDATE "service_catalog" SET "slug" = candidate WHERE "id" = service_row."id";
  END LOOP;
END $$;

ALTER TABLE "service_catalog" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "service_catalog_adminId_slug_key" ON "service_catalog"("adminId", "slug");

-- Review rows from the old workflow become explicit JOB/STAFF + JOB_TOKEN rows.
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "scope" "ReviewScope";
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "source" "ReviewSource";
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "websiteId" TEXT;

UPDATE "review"
SET "source" = 'JOB_TOKEN'::"ReviewSource"
WHERE "source" IS NULL;

UPDATE "review"
SET "scope" = CASE
  WHEN "staffId" IS NOT NULL THEN 'STAFF'::"ReviewScope"
  ELSE 'JOB'::"ReviewScope"
END
WHERE "scope" IS NULL;

UPDATE "review" AS r
SET
  "serviceCatalogId" = COALESCE(r."serviceCatalogId", j."serviceCatalogId"),
  "serviceNameSnapshot" = COALESCE(r."serviceNameSnapshot", j."serviceNameSnapshot", sc."serviceName")
FROM "job" AS j
LEFT JOIN "service_catalog" AS sc ON sc."id" = j."serviceCatalogId"
WHERE r."jobId" = j."id";

ALTER TABLE "review" ALTER COLUMN "scope" SET DEFAULT 'JOB';
ALTER TABLE "review" ALTER COLUMN "source" SET DEFAULT 'JOB_TOKEN';
ALTER TABLE "review" ALTER COLUMN "scope" SET NOT NULL;
ALTER TABLE "review" ALTER COLUMN "source" SET NOT NULL;

-- Website reviews intentionally do not have a review token or Job.
ALTER TABLE "review" ALTER COLUMN "reviewTokenId" DROP NOT NULL;
ALTER TABLE "review" ALTER COLUMN "jobId" DROP NOT NULL;

-- The old FK cascaded Review deletion when a review token was removed. That is
-- undesirable for durable review history; nullable links now use SET NULL.
ALTER TABLE "review" DROP CONSTRAINT IF EXISTS "review_reviewTokenId_fkey";
ALTER TABLE "review"
  ADD CONSTRAINT "review_reviewTokenId_fkey"
  FOREIGN KEY ("reviewTokenId") REFERENCES "review_token"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

DO $$ BEGIN
  ALTER TABLE "review"
    ADD CONSTRAINT "review_serviceCatalogId_fkey"
    FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "review"
    ADD CONSTRAINT "review_websiteId_fkey"
    FOREIGN KEY ("websiteId") REFERENCES "business_website"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "review_adminId_scope_source_createdAt_idx"
  ON "review"("adminId", "scope", "source", "createdAt");
CREATE INDEX IF NOT EXISTS "review_serviceCatalogId_createdAt_idx"
  ON "review"("serviceCatalogId", "createdAt");
CREATE INDEX IF NOT EXISTS "review_websiteId_createdAt_idx"
  ON "review"("websiteId", "createdAt");

-- Private website-review contact information is deliberately separated from
-- the public Review projection. Only authenticated admin endpoints include it.
CREATE TABLE IF NOT EXISTS "website_review_contact" (
  "id" TEXT NOT NULL,
  "reviewId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "submissionKeyHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "website_review_contact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "website_review_contact_reviewId_key"
  ON "website_review_contact"("reviewId");
CREATE UNIQUE INDEX IF NOT EXISTS "website_review_contact_submissionKeyHash_key"
  ON "website_review_contact"("submissionKeyHash");
CREATE INDEX IF NOT EXISTS "website_review_contact_adminId_createdAt_idx"
  ON "website_review_contact"("adminId", "createdAt");
CREATE INDEX IF NOT EXISTS "website_review_contact_websiteId_createdAt_idx"
  ON "website_review_contact"("websiteId", "createdAt");
CREATE INDEX IF NOT EXISTS "website_review_contact_email_idx"
  ON "website_review_contact"("email");

DO $$ BEGIN
  ALTER TABLE "website_review_contact"
    ADD CONSTRAINT "website_review_contact_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "review"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "website_review_contact"
    ADD CONSTRAINT "website_review_contact_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "website_review_contact"
    ADD CONSTRAINT "website_review_contact_websiteId_fkey"
    FOREIGN KEY ("websiteId") REFERENCES "business_website"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
