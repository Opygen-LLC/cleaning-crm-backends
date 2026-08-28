#!/usr/bin/env bash
set -euo pipefail

# Enterprise Phase 2 release gate. The caller supplies the provider-specific
# backup/recovery-point command; this script deliberately refuses to guess one.
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DATABASE_BACKUP_COMMAND:?Set DATABASE_BACKUP_COMMAND to your verified database backup/recovery-point command}"

mkdir -p release-artifacts

pnpm run release:phase2:verify
pnpm run build
node scripts/captureProductionSchemaBaseline.mjs
node scripts/phase2MigrationPreflight.mjs

echo "Creating database recovery point..."
bash -lc "$DATABASE_BACKUP_COMMAND"

echo "Deploying checked-in Prisma migrations..."
pnpm exec prisma migrate deploy

# Repair historical ACTIVE+verified ADMIN accounts before application traffic
# relies on the new invariant. Safe to rerun; each user is advisory-locked.
node dist/reconcileAdminProvisioning.js

node scripts/phase2DriftCheck.mjs

echo "Phase 2 database/provisioning release gates passed. Roll out the application, wait for /readyz, run smoke tests, then shift traffic."
