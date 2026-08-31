ALTER TABLE "business_website"
  ADD COLUMN IF NOT EXISTS "metaKeywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "googleAnalyticsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "googleAnalyticsMeasurementId" TEXT;

ALTER TABLE "website_page"
  ADD COLUMN IF NOT EXISTS "seoKeywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "socialImageUrl" TEXT;

CREATE TABLE IF NOT EXISTS "website_google_analytics_connection" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "refreshTokenEncrypted" TEXT NOT NULL,
  "googleEmail" TEXT,
  "propertyId" TEXT,
  "propertyName" TEXT,
  "accountName" TEXT,
  "measurementId" TEXT,
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "website_google_analytics_connection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "website_google_analytics_connection_websiteId_key"
  ON "website_google_analytics_connection"("websiteId");
CREATE INDEX IF NOT EXISTS "website_google_analytics_connection_propertyId_idx"
  ON "website_google_analytics_connection"("propertyId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'website_google_analytics_connection_websiteId_fkey'
  ) THEN
    ALTER TABLE "website_google_analytics_connection"
      ADD CONSTRAINT "website_google_analytics_connection_websiteId_fkey"
      FOREIGN KEY ("websiteId") REFERENCES "business_website"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
