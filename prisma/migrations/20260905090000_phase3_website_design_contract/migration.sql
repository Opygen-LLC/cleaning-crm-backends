-- Phase 3: one canonical server-side Website Studio design contract.
-- Existing tenants receive an empty V1 override set, preserving their current
-- base-template appearance exactly until they choose components later.
ALTER TABLE "business_website"
  ADD COLUMN IF NOT EXISTS "websiteDesign" JSONB NOT NULL
  DEFAULT '{"schemaVersion":1,"componentOverrides":{},"componentAnimations":{},"sectionStyles":{},"animationsEnabled":true}'::jsonb;

-- Keep the default for future rows as a fail-safe even if a provisioning path
-- does not explicitly provide design JSON.
ALTER TABLE "business_website"
  ALTER COLUMN "websiteDesign" SET DEFAULT
  '{"schemaVersion":1,"componentOverrides":{},"componentAnimations":{},"sectionStyles":{},"animationsEnabled":true}'::jsonb;
