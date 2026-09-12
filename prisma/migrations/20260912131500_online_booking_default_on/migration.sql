-- Phase 3: online booking is available on every plan and is the default for
-- newly provisioned websites. Existing tenants are reconciled separately by
-- the idempotent `online-booking:defaults:fix` command so custom forms are not
-- overwritten and published websites are migrated safely.
ALTER TABLE "business_website"
  ALTER COLUMN "bookingEnabled" SET DEFAULT true;
