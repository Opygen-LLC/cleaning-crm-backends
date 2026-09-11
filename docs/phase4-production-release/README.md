# Cleaning CRM Phase 4 production release

This release closes the Cleaning CRM Reviews, SaaS trial/subscription, default-services and table-action work with cross-layer regression and production hardening.

## What changed in Phase 4

- Review token/id/job route parameters are UUID-validated before database access.
- Public job-token review submissions are JSON-only and capped by the existing review request body limit.
- Review date filters reject invalid/reversed ranges, and empty moderation PATCH bodies are rejected.
- Review read/update/resend operations use the same source-relation tenant guard, not only the top-level `adminId`.
- Public company/service review context and submission now obey the same effective `reviews` entitlement as the admin Reviews module; anonymous visitors receive a public-safe unavailable response after downgrade/expiry.
- Service list query parameters are validated and pagination now happens on the backend. The success envelope remains `data: Service[]` and adds canonical `meta` containing page/limit/total/totalPages and whole-catalogue summary stats.
- Subscription billing-history page/limit inputs are validated.
- Public website service projections and service-review lookup explicitly exclude archived catalogue rows.
- Production access tokens fail fast when configured longer than 15 minutes.
- Winston metadata/string redaction covers authorization/cookies/passwords/OTP/token/secret/API-key/database-URL shaped values.
- `.env.example` contains placeholders only. It is documentation, never a deployable secret file; the secret gate also catches suspicious commented assignments.
- Tenant hard-delete waits for all independent public/private/temporary R2 purge attempts to settle before deciding success or retry, preventing unknown partial cleanup state.
- The website rollout gate was aligned with the current durable publication-delivery service rather than the removed legacy immediate-delivery path.

No new Prisma migration is introduced in Phase 4. The Phase 3 migration `20260911190500_phase3_service_catalog_archiving` remains required if it has not already been deployed.

## Required production order

1. Back up PostgreSQL and confirm restore/PITR procedures.
2. Rotate any credential that was ever copied into a committed/example environment file. Removing a value from source control does not revoke it.
3. Configure production secrets in the deployment secret store. `ACCESS_TOKEN_EXPIRES_IN` must be `15m` or shorter, and access/refresh/Better Auth secrets must be distinct random values of at least 32 characters.
4. Set the API process to `PROCESS_ROLE=api` with `OUTBOX_WORKER_ENABLED=false` and keep the dedicated worker enabled in its own process.
5. Run `pnpm install --frozen-lockfile`, `pnpm run generate`, `pnpm exec prisma validate`, `pnpm run db:migrate:status`, then `pnpm run db:migrate:deploy` if migrations are pending.
6. Run `pnpm run release:phase4:cleaning-crm` before publishing the backend image/revision.
7. Deploy backend API, worker and scheduler using the same release SHA and compatible environment; wait for readiness, not only process liveness.
8. Run backend route/auth/review/subscription/service smoke tests against staging.
9. Deploy the matching frontend release and run `pnpm run release:phase4:cleaning-crm` there before promotion.
10. Verify desktop and mobile flows, then promote gradually and watch errors, rate limits, outbox age, database saturation, upload failures and subscription/review errors.

Never use `prisma db push` for this production release. Use checked-in migrations and `prisma migrate deploy` only.

## Staging smoke matrix

Use two separate tenant organizations plus an unauthenticated browser. Verify: cross-tenant service/review IDs return 404/403 without disclosing the other tenant; company/service/job review links submit correctly; a used/expired job token behaves correctly; trial days and entitlements match `/subscription/me`; expired accounts retain only the intended recovery surface; service list page 2 is distinct from page 1 and stats remain whole-catalogue totals; malformed page/limit/UUID/date inputs return the canonical validation envelope; service create/edit shows inline field errors; table menus remain attached to their trigger and work with mouse, touch, Arrow keys, Home/End, Escape and Tab.

## Rollback

Phase 4 contains no schema migration, so application rollback is code-only provided Phase 3 schema has already been deployed. If a release is unhealthy, stop promotion, route traffic to the previous backend/frontend revisions, keep the worker version compatible with the previous API revision, and do not roll back the Phase 3 additive `archivedAt` migration. Preserve logs/request IDs and capture the failing payload shape before retrying.
