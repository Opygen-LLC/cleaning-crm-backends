-- Phase 1 reliability repair.
-- These columns already exist in the Prisma NotificationPreference model but
-- were never added by a forward migration. Keep this migration idempotent so
-- environments that received a manual hotfix remain deployable.
ALTER TABLE "notification_preference"
  ADD COLUMN IF NOT EXISTS "emailBookingDayOfReminder" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "emailQuoteSent" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "emailInvoiceSent" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "emailReviewRequest" BOOLEAN NOT NULL DEFAULT true;
