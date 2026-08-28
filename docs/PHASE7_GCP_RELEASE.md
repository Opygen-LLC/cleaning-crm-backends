# Phase 7 — Google Cloud production qualification

Use one GCP region for the Compute Engine Managed Instance Group, Cloud SQL PostgreSQL and Redis/Memorystore. Build an immutable image tagged with `RELEASE_VERSION=$GIT_SHA` and create a new instance template; never mutate live instances in-place.

Release order: lint → typecheck → server/unit/integration tests → frontend Vitest/RTL → Playwright against staging → `prisma migrate status` + Phase 2 migration preflight → builds → staging deploy → warm/cold k6 smoke → create production instance template → `scripts/gcp/phase7-canary.sh` (5%, 25%, 100%).

The canary script filters structured Cloud Logging events by `jsonPayload.releaseSha`, rejects high p95/5xx/client-error/Redis-error/onboarding-regression signals, and rolls the MIG back to `PREVIOUS_TEMPLATE` on failure. Configure Cloud SQL connection-utilization alerting as an independent infrastructure policy (recommended warning 70%, rollback/block at 85%) because DB saturation is a fleet resource metric rather than an individual request property.

Never enable `E2E_TEST_HOOKS_ENABLED` in production. Staging must use a dedicated synthetic email domain and a 32+ character `E2E_TEST_TOKEN` stored in Google Secret Manager.
