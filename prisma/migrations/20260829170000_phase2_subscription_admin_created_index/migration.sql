-- Phase 2: optimize latest-subscription lookups used by admin usage, billing, and guards.
CREATE INDEX IF NOT EXISTS "Subscription_adminId_createdAt_idx"
  ON "Subscription"("adminId", "createdAt" DESC);
