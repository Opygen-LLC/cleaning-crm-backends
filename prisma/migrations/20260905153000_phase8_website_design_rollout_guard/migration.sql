-- Phase 8 production rollout guard.
-- Preserve every existing component/animation/style selection while ensuring
-- old or partially-migrated rows have the complete V1 contract shape.
-- Empty overrides intentionally continue rendering the original base template.
WITH defaults AS (
  SELECT '{"schemaVersion":1,"componentOverrides":{},"componentAnimations":{},"sectionStyles":{},"animationsEnabled":true}'::jsonb AS value
)
UPDATE "business_website" AS website
SET "websiteDesign" = defaults.value ||
  CASE
    WHEN jsonb_typeof(website."websiteDesign") = 'object' THEN website."websiteDesign"
    ELSE '{}'::jsonb
  END
FROM defaults
WHERE website."websiteDesign" IS NULL
   OR jsonb_typeof(website."websiteDesign") <> 'object'
   OR NOT (website."websiteDesign" ? 'schemaVersion')
   OR NOT (website."websiteDesign" ? 'componentOverrides')
   OR NOT (website."websiteDesign" ? 'componentAnimations')
   OR NOT (website."websiteDesign" ? 'sectionStyles')
   OR NOT (website."websiteDesign" ? 'animationsEnabled');

-- Keep future rows fail-safe even if an older provisioning path is briefly
-- running during a rolling deployment.
ALTER TABLE "business_website"
  ALTER COLUMN "websiteDesign" SET DEFAULT
  '{"schemaVersion":1,"componentOverrides":{},"componentAnimations":{},"sectionStyles":{},"animationsEnabled":true}'::jsonb;

-- Repeat the Phase 1 compatibility repair idempotently. This is safe during
-- rolling deploys and prevents a legacy account from being stranded on the
-- removed Template onboarding step.
UPDATE "AdminProfile"
SET "onboardingCompletedSteps" = array_replace(
  "onboardingCompletedSteps",
  'template',
  'review_launch'
)
WHERE 'template' = ANY("onboardingCompletedSteps");
