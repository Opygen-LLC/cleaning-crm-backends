-- Phase 2: canonical onboarding/service contracts and legacy-data normalization.
-- Data-preserving and deterministic: arbitrary historical service categories are
-- mapped to one of the three supported machine values before the column is
-- constrained, legacy staff DEACTIVE rows become INACTIVE, and partial opening
-- hours are rewritten to the seven-day canonical JSON contract.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ServiceCategory') THEN
    CREATE TYPE "ServiceCategory" AS ENUM ('RESIDENTIAL', 'COMMERCIAL', 'SPECIALIST');
  END IF;
END $$;

ALTER TABLE "service_catalog"
  ALTER COLUMN "category" TYPE "ServiceCategory"
  USING (
    CASE
      WHEN lower(regexp_replace(trim("category"), '[^a-zA-Z0-9]+', '_', 'g')) ~ '(commercial|office|business)'
        THEN 'COMMERCIAL'
      WHEN lower(regexp_replace(trim("category"), '[^a-zA-Z0-9]+', '_', 'g')) ~ '(residential|standard|home|domestic|tenancy|move_in|move_out)'
        THEN 'RESIDENTIAL'
      ELSE 'SPECIALIST'
    END
  )::"ServiceCategory";

ALTER TABLE "service_catalog"
  ALTER COLUMN "category" SET DEFAULT 'RESIDENTIAL'::"ServiceCategory";

-- Preserve the old manual-disable meaning separately, normalize the legacy
-- inactive spelling, then rebuild the enum so the DB/generated client expose
-- exactly one inactive status value.
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "manuallyInactive" BOOLEAN NOT NULL DEFAULT false;
UPDATE "StaffProfile" SET "manuallyInactive" = true WHERE "status"::text = 'DEACTIVE';

UPDATE "StaffProfile"
SET "status" = 'INACTIVE'::"StaffStatus"
WHERE "status"::text = 'DEACTIVE';

ALTER TABLE "StaffProfile" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "StaffStatus" RENAME TO "StaffStatus_legacy";
CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ON_LEAVE');
ALTER TABLE "StaffProfile"
  ALTER COLUMN "status" TYPE "StaffStatus"
  USING ("status"::text::"StaffStatus");
ALTER TABLE "StaffProfile" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"StaffStatus";
DROP TYPE "StaffStatus_legacy";

WITH source AS (
  SELECT id, COALESCE("businessHours"::jsonb, '{}'::jsonb) AS hours
  FROM "AdminProfile"
  WHERE "businessHours" IS NOT NULL
), normalized AS (
  SELECT
    id,
    (
      CASE
        WHEN jsonb_typeof(hours -> 'timezone') = 'string'
          AND length(trim(hours ->> 'timezone')) > 0
        THEN jsonb_build_object('timezone', trim(hours ->> 'timezone'))
        ELSE '{}'::jsonb
      END
    ) || jsonb_build_object(
      'monday', jsonb_build_object(
        'isOpen', CASE WHEN jsonb_typeof(hours #> '{monday,isOpen}') = 'boolean' THEN (hours #>> '{monday,isOpen}')::boolean ELSE true END,
        'opensAt', CASE WHEN (hours #>> '{monday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{monday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{monday,opensAt}' < hours #>> '{monday,closesAt}') THEN hours #>> '{monday,opensAt}' ELSE '09:00' END,
        'closesAt', CASE WHEN (hours #>> '{monday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{monday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{monday,opensAt}' < hours #>> '{monday,closesAt}') THEN hours #>> '{monday,closesAt}' ELSE '17:00' END
      ),
      'tuesday', jsonb_build_object(
        'isOpen', CASE WHEN jsonb_typeof(hours #> '{tuesday,isOpen}') = 'boolean' THEN (hours #>> '{tuesday,isOpen}')::boolean ELSE true END,
        'opensAt', CASE WHEN (hours #>> '{tuesday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{tuesday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{tuesday,opensAt}' < hours #>> '{tuesday,closesAt}') THEN hours #>> '{tuesday,opensAt}' ELSE '09:00' END,
        'closesAt', CASE WHEN (hours #>> '{tuesday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{tuesday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{tuesday,opensAt}' < hours #>> '{tuesday,closesAt}') THEN hours #>> '{tuesday,closesAt}' ELSE '17:00' END
      ),
      'wednesday', jsonb_build_object(
        'isOpen', CASE WHEN jsonb_typeof(hours #> '{wednesday,isOpen}') = 'boolean' THEN (hours #>> '{wednesday,isOpen}')::boolean ELSE true END,
        'opensAt', CASE WHEN (hours #>> '{wednesday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{wednesday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{wednesday,opensAt}' < hours #>> '{wednesday,closesAt}') THEN hours #>> '{wednesday,opensAt}' ELSE '09:00' END,
        'closesAt', CASE WHEN (hours #>> '{wednesday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{wednesday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{wednesday,opensAt}' < hours #>> '{wednesday,closesAt}') THEN hours #>> '{wednesday,closesAt}' ELSE '17:00' END
      ),
      'thursday', jsonb_build_object(
        'isOpen', CASE WHEN jsonb_typeof(hours #> '{thursday,isOpen}') = 'boolean' THEN (hours #>> '{thursday,isOpen}')::boolean ELSE true END,
        'opensAt', CASE WHEN (hours #>> '{thursday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{thursday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{thursday,opensAt}' < hours #>> '{thursday,closesAt}') THEN hours #>> '{thursday,opensAt}' ELSE '09:00' END,
        'closesAt', CASE WHEN (hours #>> '{thursday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{thursday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{thursday,opensAt}' < hours #>> '{thursday,closesAt}') THEN hours #>> '{thursday,closesAt}' ELSE '17:00' END
      ),
      'friday', jsonb_build_object(
        'isOpen', CASE WHEN jsonb_typeof(hours #> '{friday,isOpen}') = 'boolean' THEN (hours #>> '{friday,isOpen}')::boolean ELSE true END,
        'opensAt', CASE WHEN (hours #>> '{friday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{friday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{friday,opensAt}' < hours #>> '{friday,closesAt}') THEN hours #>> '{friday,opensAt}' ELSE '09:00' END,
        'closesAt', CASE WHEN (hours #>> '{friday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{friday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{friday,opensAt}' < hours #>> '{friday,closesAt}') THEN hours #>> '{friday,closesAt}' ELSE '17:00' END
      ),
      'saturday', jsonb_build_object(
        'isOpen', CASE WHEN jsonb_typeof(hours #> '{saturday,isOpen}') = 'boolean' THEN (hours #>> '{saturday,isOpen}')::boolean ELSE false END,
        'opensAt', CASE WHEN (hours #>> '{saturday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{saturday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{saturday,opensAt}' < hours #>> '{saturday,closesAt}') THEN hours #>> '{saturday,opensAt}' ELSE '09:00' END,
        'closesAt', CASE WHEN (hours #>> '{saturday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{saturday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{saturday,opensAt}' < hours #>> '{saturday,closesAt}') THEN hours #>> '{saturday,closesAt}' ELSE '17:00' END
      ),
      'sunday', jsonb_build_object(
        'isOpen', CASE WHEN jsonb_typeof(hours #> '{sunday,isOpen}') = 'boolean' THEN (hours #>> '{sunday,isOpen}')::boolean ELSE false END,
        'opensAt', CASE WHEN (hours #>> '{sunday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{sunday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{sunday,opensAt}' < hours #>> '{sunday,closesAt}') THEN hours #>> '{sunday,opensAt}' ELSE '09:00' END,
        'closesAt', CASE WHEN (hours #>> '{sunday,opensAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{sunday,closesAt}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND hours #>> '{sunday,opensAt}' < hours #>> '{sunday,closesAt}') THEN hours #>> '{sunday,closesAt}' ELSE '17:00' END
      )
    ) AS canonical_hours
  FROM source
)
UPDATE "AdminProfile" AS admin
SET "businessHours" = normalized.canonical_hours
FROM normalized
WHERE admin.id = normalized.id
  AND admin."businessHours"::jsonb IS DISTINCT FROM normalized.canonical_hours;
