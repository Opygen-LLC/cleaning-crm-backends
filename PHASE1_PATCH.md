# Phase 1 launch correctness patch

## Apply this archive

This is an overlay, not a complete project. Extract it into the matching original
repository root, preserving paths. Back up or commit local edits first. Do not
extract the frontend archive into the backend repository, or vice versa.
`_phase1_patch/manifest.json` identifies the original input archive and lists
SHA-256 hashes for every delivered file other than the manifest itself. Files not
listed are deliberately unchanged. There are no deletions or database-schema
migrations in this patch, and there are no dependencies, generated clients, secrets,
certificates, private keys, or captured customer data in either archive.

## Verification boundary - read before deployment

The implementation and local model tests are delivered. **Production deployment
and staging readiness have not been verified.** There was no staging/cloud access,
no installed project dependency tree or Prisma-generated client, and no running
PostgreSQL/Redis/browser integration environment. Package installation was blocked
by this execution environment's network/DNS restrictions. A backend full typecheck
attempt stopped at TS2688 (missing the Node type package); the frontend full
semantic typecheck, framework builds, ESLint, and dependency-backed Vitest suites
were not run. Syntax/transpilation checks are not semantic typechecking.

No real clean or failed registration-to-launch staging traces were captured. The
frontend includes a runnable two-scenario trace harness and a non-skipping staging
workflow. Do not substitute its model-test results for staging measurements or
claim measured SQL/Redis timings from them. Wildcard DNS/TLS was not provisioned;
the platform deployment tools and validation gate are supplied for an authorized
operator. Complete the release gates below before treating this patch as ready for
production traffic.

## Local validation actually performed

- Backend: 18/18 source-executing unit/model regressions passed. Infrastructure,
  transaction serialization, cache commands, and external callbacks are explicit
  doubles; this does not validate real PostgreSQL locking or actual Redis Lua.
- Frontend: 13/13 source-executing completion/cache/identity/visit-state unit tests
  passed; these do not mount a React tree or run a browser.
- Existing frontend website contract suite: 33/33 passed.
- Four targeted regressions run against the original backend source: 4/4 failed
  as expected (cached DRAFT route, review prerequisite, stale-revision retry, and
  lost-response retry). The same four pass against the patched implementation.
- Changed TypeScript/TSX transpilation and JavaScript syntax checks passed; changed
  workflow YAML parsed, and `git diff --check` passed. The backend's existing
  production **source-contract** gate passed, not a deployment verification.
- Missing staging configuration explicitly exits the trace runner with code 2;
  it is never reported as a passing/skipped registration test.

See `_phase1_patch/validation-results.json` for the per-test results and explicit
NOT_RUN/BLOCKED release checks. Local model test times are not endpoint latency
measurements or performance-budget evidence.

## Release order and mandatory gates

1. Install the original lockfile dependencies with the repository's declared pnpm
   version. Generate/validate the backend Prisma client. Run both full typechecks,
   builds, lint where configured, the existing Vitest suites, and native Phase 1
   tests. No dependency or schema change is required by this overlay.
2. Deploy/upgrade **all existing outbox workers before the API**. The same
   OutboxEvent table and worker now recognize `PUBLIC_WEBSITE_DELIVERY_REQUESTED`.
   This is not another queue. Old workers do not understand that topic and must
   not consume newly enqueued full-delivery work. Keep the upgraded workers during
   an API rollback until pending new-topic work has been drained.
3. Deploy the compatible backend contract/cache changes, then the frontend. Ensure
   both services use the same website base domain and the correct application
   hosts. Configure the existing signed Next revalidation URL/secret; keep the
   immediate `revalidateTag(..., { expire: 0 })` behavior.
4. Review/apply the existing-publication delivery reconciliation described in the
   backend notes. This creates receipts only, not another website, snapshot, or
   publication revision. Wait for the existing worker to process the receipts.
5. Provision platform wildcard DNS/TLS centrally once, or validate the existing
   installation. Run the external DNS/TLS/first-HTML preflight and both staging
   registration traces in the frontend package. Custom-domain tests/configuration
   remain separate and are not a condition for running core platform-host tests.
6. Canary with cached unpublished access, warm routes/projections, override and
   subscription expiry, suspension/restoration, Redis failure/recovery, and an API
   restart after commit. Confirm one dashboard transition, identical website and
   committed publication revision on retry, and no false live/ready indication.
   Watch the existing outbox's RETRY/DEAD rows and delivery/trace logs before rollout.

## Cache/clock operational assumptions

The existing cache architecture uses multi-key Redis Lua operations. Use its
supported single logical Redis deployment; a sharded Redis Cluster would require
an explicit hash-slot migration and is not introduced by this patch. Configure
Redis so non-expiring generation keys cannot be evicted while dependent values
survive (for example noeviction, or a suitable volatile-only eviction policy with
memory alerts). Do not delete generation keys independently. Flush access,
routing, projection, and Next caches together when changing cache topology or
restoring a cache backup. Monitor NTP/clock synchronization across API, worker,
web, and Redis hosts. Every relevant read also checks an absolute authorization
expiry, including sub-second expiry; a TTL by itself is not the authorization
boundary.

## Preserved boundaries

The snapshot and onboarding-completion transaction, tenant/role/ownership checks,
preview behavior, published snapshots, and existing outbox recovery remain in use.
Separate legacy review completion remains valid; final launch can complete review
atomically. This patch does not implement Phases 2-6 or certify their unrelated
features, migration history, or deployment configuration.

## Backend changes

`WebsiteService` records publication delivery in the existing outbox inside the
same transaction as the published snapshot and `onboardingCompletedAt`. Existing
advisory locking remains; an already-completed launch returns the committed
publication before stale expected-revision validation and does not overwrite a
newer editor draft. A first launch still enforces draft conflicts. The final review
milestone is included transactionally, including for legacy separately-reviewed
callers.

`TenantAccessResolver` adds generation-aware reads/CAS writes, actual invalidation
results, absolute subscription/override expiry bounds, and a fail-closed storage
configuration error. Host routing carries the epoch and deadline; projection
fresh/stale entries cannot authorize past their absolute deadline. Lifecycle
mutations invalidate access before any dependent rebuild and enqueue full access
change work transactionally in the existing outbox.

`WebsitePublicationDeliveryService` is shared by immediate delivery and the same
outbox worker. It verifies successful invalidation, signed Next revalidation,
platform/canonical host identity, actual Redis projection warming, the committed
revision, and a final authorization check. A failed cache write or DB fallback is
not confirmed readiness. A committed publication may return `ready: false` with
`state: preparing`; onboarding can be complete while delivery is retried durably.
External DNS/TLS is checked by the platform preflight, not by the internal resolver.

`POST /website/launch` retains the existing website/publicUrl fields and adds an
identity-bound completion, canonical authenticated session, onboarding status,
compact website status, and delivery outcomes. The response is private/no-store.
`GET /website/status` is authenticated and compact: it does not read analytics,
snapshot content, or revision history. It requires the current revision's durable
processed receipt and current authorization before returning live.

### Reconcile pre-existing published sites

A site published before this patch has no new delivery receipt. Its public routes
can still work, but compact status intentionally stays preparing until delivery is
verified. Do not fabricate processed receipts or set live flags manually.

```sh
pnpm install --frozen-lockfile
pnpm run generate
pnpm exec prisma validate
pnpm run test:phase1:launch
pnpm run test:phase5:website-studio
pnpm exec vitest run src/modules/Website/websiteLaunch.service.test.ts src/modules/Website/websiteHostResolver.production.test.ts
pnpm run typecheck
pnpm run build

# Read-only report first. Review invalid publications before applying anything.
pnpm run publication:reconcile
# Explicitly enqueue only validated missing publication receipts.
pnpm run publication:reconcile:apply
# Deliberate operator retry of dead receipts, only after fixing their cause.
pnpm exec tsx src/scripts/phase1/reconcilePublicationDelivery.ts --apply --retry-dead
# Built production equivalent; defaults to dry-run without --apply.
node dist/reconcilePublicationDelivery.js --dry-run
```

The report's `healthy` means an existing non-DEAD receipt was found, not that its
website was served successfully. Inspect receipt status and `/website/status`.
The command never publishes, changes onboarding, or repairs malformed snapshots;
it reports invalid rows for review. It shares the existing per-website advisory
lock and can be rerun without creating duplicate publication delivery rows.

### Baseline reproduction

```sh
PHASE1_SOURCE_ROOT=/path/to/unmodified/backend node --test --test-name-pattern='^regression:' tests/phase1/launch-regressions.test.cjs
```

An exit code of 1 with four failures is expected only for that original baseline.
Do not set PHASE1_SOURCE_ROOT in normal patched CI/release tests.

### Primary implementation references

- Redis atomic script semantics: https://redis.io/docs/latest/develop/programmability/eval-intro/
- Redis expiration semantics: https://redis.io/docs/latest/commands/pexpire/
