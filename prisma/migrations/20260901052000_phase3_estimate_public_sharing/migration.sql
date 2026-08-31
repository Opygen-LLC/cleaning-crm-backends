-- Phase 3: estimate public sharing and email preference.
-- Forward-only migration; do not edit already-applied historical migrations.

ALTER TABLE "estimate"
  ADD COLUMN IF NOT EXISTS "publicToken" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "responseNote" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "estimate_publicToken_key"
  ON "estimate"("publicToken");

ALTER TABLE "notification_preference"
  ADD COLUMN IF NOT EXISTS "emailEstimateSent" BOOLEAN NOT NULL DEFAULT true;
