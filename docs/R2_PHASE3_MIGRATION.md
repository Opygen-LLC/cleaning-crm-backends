# Cloudflare R2 Phase 3 migration runbook

Phase 3 removes Cloudinary from runtime code and migrates legacy media to Cloudflare R2. Keep the legacy provider available until the final verification command reports zero legacy references and zero R2 verification failures.

## Release order

1. Back up the production database and confirm the backup can be restored.
2. Configure the Phase 1/2 R2 environment variables in the API and worker environments. Production startup now fails if the R2 provider is missing or invalid.
3. Apply the Prisma migration `20260910200000_r2_phase3_hardening` and regenerate Prisma Client.
4. Deploy this code while the existing legacy media URLs are still reachable.
5. Apply the private-bucket temporary-object lifecycle with `pnpm r2:lifecycle:apply`.
6. Inventory legacy references with `pnpm media:migrate:r2:dry-run`.
7. Run `pnpm media:migrate:r2`. The command is restartable; each source/entity/purpose tuple has an idempotent migration ledger and deterministic final R2 key.
8. Run `pnpm media:migrate:r2:verify`. Do not remove legacy provider data if either `remainingLegacyReferences` or `r2VerificationFailures` is non-zero.
9. Review `legacy_media_migration` rows with `FAILED`, `MISSING`, or `INVALID` status. Correct the source/problem and rerun the migration.
10. Exercise public websites (including already-published snapshots/revisions), avatars, job attachments, receipts, expense proofs, billing/payment proofs and invoices.
11. After verification is clean, revoke/delete old Cloudinary credentials and remove legacy provider data according to your retention policy.

## Optional tenant-scoped migration

Use `--admin-id=<AdminProfile.id>` with the migration scripts for staged rollout or remediation of one organization.

## Safety properties

- Only HTTPS legacy Cloudinary delivery hosts are accepted as migration sources; redirects are revalidated and bounded.
- Download size and timeout are bounded before Sharp/PDF validation.
- Public media uses immutable versioned R2 keys and one-year cache headers.
- Private media uses `private, no-store` and is served by short-lived signed R2 URLs after tenant authorization.
- Temporary uploads live under `tmp/{organizationId}/` and are expired after one day.
- Organization hard-delete removes `organizations/{organizationId}/` from both buckets and `tmp/{organizationId}/` from the private bucket before the database cascade.
