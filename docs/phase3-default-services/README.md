# Phase 3 - Default cleaning services and shared table action menu

## Backend scope

Phase 3 adds a tenant-owned starter service catalogue and history-safe service removal.

- New admin accounts are provisioned with nine recommended cleaning services.
- Presets are ordinary `ServiceCatalog` rows. They can be renamed, edited, disabled, or removed by the tenant.
- Presets start `INACTIVE`, `onlineBookingEnabled=false`, and `basePrice=0`. The API refuses activation until the tenant sets a price greater than zero.
- Website booking no longer fabricates a priced default service when a tenant has not configured one.
- Existing tenants can use `GET /service-catalog/recommended` and idempotent `POST /service-catalog/recommended/import`.
- Re-import skips installed presets and restores matching archived presets without breaking their historical identity.
- Deleting an unreferenced service hard-deletes it. Deleting a service used by historical CRM records archives it, disables it, and removes it from current-catalog reads.
- New account provisioning through both self-service registration and the wired super-admin account-creation flow uses the same safe starter catalogue.

## Database change

A forward Prisma migration adds nullable `ServiceCatalog.archivedAt` and an index for current-catalog reads:

`prisma/migrations/20260911190500_phase3_service_catalog_archiving/migration.sql`

This migration must be deployed before the Phase 3 backend because the new code queries `archivedAt`.

## Deployment order

1. Install the locked backend dependencies.
2. Run `pnpm run db:migrate:deploy` against the target database.
3. Run `pnpm run generate` so the Prisma client includes `archivedAt`.
4. Run the normal typecheck/tests/build in CI or staging.
5. Deploy the backend and smoke-test the services/recommended endpoints.
6. Deploy the Phase 3 frontend.

No new environment variables are required for Phase 3.

## Rollback note

The new database column is nullable and safe to leave in place if application code must be rolled back. Do not remove the migration/column while any Phase 3 backend instance is still running.
