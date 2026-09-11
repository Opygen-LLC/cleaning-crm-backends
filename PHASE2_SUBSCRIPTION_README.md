# Phase 2 - Subscription / Trial production handoff

## What changed

Phase 2 makes `GET /subscription/me` the authoritative subscription read model for the admin UI. It now returns the canonical entitlement/access decision, a server-computed lifecycle/countdown, and a recovery-safe usage snapshot. Trial expiry is derived on the server even if the asynchronous expiry worker has not yet persisted `EXPIRED`.

Automatic trial provisioning now uses a transaction-level advisory lock and refuses to provision a second trial whenever the tenant already has subscription history. The trusted fresh-registration transaction can still provision the first trial exactly once.

Plan checkout remains staged in `PendingPlanChange`; the live paid subscription or active trial is not replaced before approval. Current and legacy payment flows are protected by the same subscription checkout advisory lock. Legacy approval is idempotent, and payment proof submissions are duplicate-aware.

Subscription payment proofs use private R2 media assets with the fixed `SUBSCRIPTION_PROOF` purpose. Recovery-specific initiate/finalize endpoints live under `/subscription`, so an expired account can upload a receipt without reopening normal media/business routes.

Expired trials/subscriptions keep their business data. A narrowly scoped recovery router keeps only the admin profile available alongside the already-open auth/subscription routes. Administrative suspension/archive/deletion states still fail closed through `TenantAccessResolver`.

## New/extended API surface

- `GET /subscription/me` adds `serverTime`, `lifecycle`, `usage`, canonical `access`, and effective entitlements/resources.
- `POST /subscription/me/proof-upload/initiate`
- `POST /subscription/me/proof-upload/:uploadId/complete`
- Existing `PATCH /subscription/me/submit-proof` now expects `paymentProofAssetId` for R2 proof media.

No Prisma schema change is required by this phase.

## Deployment order

Deploy the backend first, then the frontend. Existing R2/media environment configuration is reused; Phase 2 adds no browser-side storage credential.

## Dependency-free verification

Run:

`node --test tests/subscription/phase2-saas-trial-contract.test.cjs`

The normal production release gates (`pnpm install --frozen-lockfile`, Prisma generation/validation, typecheck, tests and build) should still run in CI/staging where project dependencies and database services are available.
