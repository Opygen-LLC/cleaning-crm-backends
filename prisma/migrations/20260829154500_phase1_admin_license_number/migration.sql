-- Phase 1 correctness: registration license/trade identifiers must not be
-- persisted in AdminProfile.website. Existing ambiguous values are reconciled
-- by `pnpm data:audit --fix`, which classifies values conservatively.
ALTER TABLE "AdminProfile"
  ADD COLUMN IF NOT EXISTS "licenseNumber" TEXT;
