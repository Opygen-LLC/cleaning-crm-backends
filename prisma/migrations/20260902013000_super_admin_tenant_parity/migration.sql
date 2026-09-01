-- Phase 1: Super Admin tenant lifecycle, audit, entitlements and scheduled plan controls.
DO $$ BEGIN
  CREATE TYPE "TenantLifecycleStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "AdminProfile"
  ADD COLUMN IF NOT EXISTS "lifecycleStatus" "TenantLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suspendedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "reactivatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "preArchiveLifecycleStatus" "TenantLifecycleStatus",
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archivedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "restoredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "restoredReason" TEXT;

ALTER TABLE "PendingPlanChange"
  ADD COLUMN IF NOT EXISTS "applyAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "isAdministrative" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reason" TEXT,
  ADD COLUMN IF NOT EXISTS "requestedByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedByUserId" TEXT;

CREATE INDEX IF NOT EXISTS "PendingPlanChange_status_applyAt_idx"
  ON "PendingPlanChange"("status", "applyAt");

CREATE TABLE IF NOT EXISTS "tenant_entitlement_override" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "resources" JSONB NOT NULL DEFAULT '{}',
  "features" JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMP(3),
  "reason" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_entitlement_override_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_entitlement_override_adminId_key" ON "tenant_entitlement_override"("adminId");
CREATE INDEX IF NOT EXISTS "tenant_entitlement_override_expiresAt_idx" ON "tenant_entitlement_override"("expiresAt");
DO $$ BEGIN
  ALTER TABLE "tenant_entitlement_override"
    ADD CONSTRAINT "tenant_entitlement_override_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "super_admin_audit_log" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT,
  "tenantAdminId" TEXT,
  "targetUserId" TEXT,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "super_admin_audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "super_admin_audit_log_actorUserId_createdAt_idx" ON "super_admin_audit_log"("actorUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "super_admin_audit_log_tenantAdminId_createdAt_idx" ON "super_admin_audit_log"("tenantAdminId", "createdAt");
CREATE INDEX IF NOT EXISTS "super_admin_audit_log_targetUserId_createdAt_idx" ON "super_admin_audit_log"("targetUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "super_admin_audit_log_action_createdAt_idx" ON "super_admin_audit_log"("action", "createdAt");
DO $$ BEGIN
  ALTER TABLE "super_admin_audit_log"
    ADD CONSTRAINT "super_admin_audit_log_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
