-- Phase 5: deletion safety and immutable Super Admin audit context.

-- PostgreSQL only permits ADD VALUE outside a transaction on older versions;
-- Prisma deploy executes this migration in a compatible manner.
ALTER TYPE "TenantLifecycleStatus" ADD VALUE IF NOT EXISTS 'PENDING_DELETION';

ALTER TABLE "AdminProfile"
  ADD COLUMN IF NOT EXISTS "deletionStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "deletionAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deletionLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletionLastError" TEXT;

CREATE INDEX IF NOT EXISTS "AdminProfile_lifecycleStatus_createdAt_idx"
  ON "AdminProfile"("lifecycleStatus", "createdAt");

ALTER TABLE "super_admin_audit_log"
  ADD COLUMN IF NOT EXISTS "before" JSONB,
  ADD COLUMN IF NOT EXISTS "after" JSONB,
  ADD COLUMN IF NOT EXISTS "requestId" TEXT,
  ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

CREATE INDEX IF NOT EXISTS "super_admin_audit_log_requestId_idx"
  ON "super_admin_audit_log"("requestId");

-- Preserve actor identity in immutable audit rows. A Super Admin with audit
-- history cannot be physically deleted without an explicit audit-retention migration.
ALTER TABLE "super_admin_audit_log"
  DROP CONSTRAINT IF EXISTS "super_admin_audit_log_actorUserId_fkey";
ALTER TABLE "super_admin_audit_log"
  ADD CONSTRAINT "super_admin_audit_log_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Super Admin audit records are append-only. The application never exposes
-- update/delete methods and this trigger also protects against accidental SQL
-- mutation after deployment.
CREATE OR REPLACE FUNCTION prevent_super_admin_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'super_admin_audit_log is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS super_admin_audit_log_immutable ON "super_admin_audit_log";
CREATE TRIGGER super_admin_audit_log_immutable
BEFORE UPDATE OR DELETE ON "super_admin_audit_log"
FOR EACH ROW EXECUTE FUNCTION prevent_super_admin_audit_mutation();
