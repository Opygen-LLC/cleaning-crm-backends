-- Phase 4: make the registration country rollout explicit and auditable.
-- We deliberately do NOT infer a missing country from IP, address, phone, or locale.
ALTER TABLE "AdminProfile"
  ADD COLUMN "countryLockedAt" TIMESTAMP(3),
  ADD COLUMN "countrySelectionRequiredAt" TIMESTAMP(3);

-- Existing tenants that already have a country retain that exact value and are
-- marked locked. createdAt is deterministic and avoids pretending we know the
-- historical registration moment.
UPDATE "AdminProfile"
SET "countryLockedAt" = COALESCE("countryLockedAt", "createdAt"),
    "countrySelectionRequiredAt" = NULL
WHERE "country" IS NOT NULL;

-- Existing tenants with no country enter a one-time explicit selection state.
UPDATE "AdminProfile"
SET "countrySelectionRequiredAt" = COALESCE("countrySelectionRequiredAt", CURRENT_TIMESTAMP),
    "countryLockedAt" = NULL
WHERE "country" IS NULL;

CREATE INDEX "AdminProfile_countrySelectionRequiredAt_idx"
  ON "AdminProfile"("countrySelectionRequiredAt");
