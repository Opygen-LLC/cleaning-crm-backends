-- Phase 1 onboarding simplification: template selection moved to Website Studio.
-- Preserve existing progress by renaming the old terminal milestone.
UPDATE "AdminProfile"
SET "onboardingCompletedSteps" = array_replace(
  "onboardingCompletedSteps",
  'template',
  'review_launch'
)
WHERE 'template' = ANY("onboardingCompletedSteps");
