# Phase 5 backend patch

## Release status and scope

This archive is a **changed-files overlay on the supplied Phase 1-4 backend**, not a replacement repository. Keep all unlisted files and all earlier migrations. The frontend overlay is a separate archive.

**This is not a staging-performance certification.** The executable regression tests in `PHASE5_VALIDATION.json` ran locally against production TypeScript functions with explicit I/O adapters. Real PostgreSQL/Redis, provider placement, migration execution, EXPLAIN results, browser traffic and the 50-100 ms targets were not measured here. A full Prisma-generated TypeScript build could not run because the supplied archives contain no dependencies and dependency installation was unavailable. Do not interpret a local test duration as an endpoint latency. Run the dependency-complete and staging gates below before promoting this release.

## Implementation

The existing `pg.Pool` passed to Prisma's PostgreSQL driver adapter is instrumented once at checkout/query boundaries, including Promise and callback overloads. Pool acquisition failures remain failures; query parameter values and connection strings are not logged. Request IDs survive asynchronous driver completion. `dbPoolAcquisitionMs` includes waiting, physical connection establishment and checkout overhead; it is **not** a measurement of only the queue. Inspect `waiting`, `idle`, `total`, event-loop delay and actual deployment topology together.

Redis observations use the existing common command dispatcher and circuit breaker. GET-family hit/miss counts are distinct from all-command latency/counts. EVAL, pipelines, write commands and circuit denials are counted. The original command promise is returned unchanged, so pipeline failures do not acquire an unhandled second rejection. Telemetry failure cannot make a successful cache/lock operation fail.

The existing request trace now drives structured request records, bounded per-route p50/p95/p99 summaries, SQL/Redis counts and timing, checkout timing, response bytes, encoding time and external-provider spans. GA HTTP/body processing is an external span. Native event-loop delay, utilization, memory, and the existing pool/infrastructure snapshots appear behind the existing monitoring access check. Diagnostic responses are private/no-store. Per-process metric rings are diagnostic views, not statistically mergeable fleet percentiles.

Tenant access resolutions are deduplicated within the live request's AsyncLocalStorage scope. Expired/rejected results are not reused. Explicit fresh lookups and lifecycle invalidation bypass/remove the memo. Cross-request authorization still uses the existing epoch-protected cache and authorization horizon; a public cache hit is not an authorization bypass. Website entitlements can derive from an already-resolved access object for the same tenant.

`GET /website/status` reads a narrow website row and the latest durable delivery receipt, then verifies current access and lightweight canonical routing identity/revision/generation. It does **not** load `publishedSnapshot`, history, page/asset collections or analytics aggregates. Missing/old receipts mean preparing/unavailable, never URL-implies-live. Full immutable projection verification stays on immediate delivery and the existing outbox recovery path. A persisted delivery receipt survives ordinary outbox retention. An old worker cannot acknowledge a newer lifecycle pointer. Outbox completion and the website receipt are committed atomically.

Configured website and Studio overview reads use minimal published-design metadata instead of loading the full published snapshot. `/website/studio/overview?includeMetrics=false` skips the analytics aggregate and supplies narrow draft tracking settings. The query parameter is optional for older clients. Historical MAX(revision) repair was removed from normal requests only after adding a reviewed monotonic reconciliation migration and database guards. Existing advisory locks, unique revision constraints, expected-revision checks and publication/onboarding transactions remain intact.

Immediate publication freshness is preserved. The Next callback still expires publication tags with `{ expire: 0 }`. Deferred recovery uses the same public-cache outbox topic, not a second queue. No speculative compound index was added without a measured plan.

## Deploy in this order

1. Apply this overlay in source control. Install the repository's pinned dependencies. With the current database still on the earlier schema, run `pnpm run perf:website:reconcile > preflight-before.json`. This is a read-only scan; inspect counters behind history/publication and invalid publications. Drafts ahead of history are legitimate unsnapshotted edits and must not be lowered. Resolve invalid rows through reviewed existing repair workflows, never a blanket status/revision update.
2. Review the additive migration `20260906050000_website_performance_read_models`. It locks website and revision tables, reconciles counters upward, adds minimal metadata/delivery columns, backfills actual available proofs and creates monotonic/design-metadata triggers. It uses 5-second lock and 120-second statement limits; failure rolls back. For large tables, rehearse on a representative clone and approve a maintenance window rather than removing safety limits blindly. Drain publication/editor/registration writers and delivery workers during the migration; do not start new code against the old schema.
3. Run `pnpm run db:migrate:deploy`, `pnpm run generate`, `pnpm exec prisma validate`, then `pnpm run release:phase5:performance`. The last command includes real typecheck/build and earlier design/publication regression suites. No dependency versions or lockfiles are changed by this patch.
4. Run `pnpm run perf:website:reconcile > preflight-after.json`. Require `postMigrationReady: true`; review that all three triggers exist/enabled, the counter constraint is validated, and deployed indexes match migrations. Upgrade **all** API and worker instances before readiness repair. Old workers do not write the new compact receipt.
5. Run `pnpm run publication:delivery:reconcile -- --dry-run`. Review the JSONL outcomes. Only after approval, use `--apply` to enqueue verification of already-committed publications through the existing outbox. `--retry-dead` additionally requires deliberate approval. No site, publication revision or onboarding milestone is created by this repair. Let workers drain, rerun the dry-run, and investigate invalid/dead/pending records. Do not set `ready=true` manually.
6. Deploy the compatible Phase 5 frontend. Canary launch, first canonical visit, a lost response/retry, stale DRAFT access, subscription/override expiry and suspension/restoration with warm caches. Keep the new additive columns/triggers if rolling application code back; a destructive down-migration would lose durable receipts and monotonic protection. Rehearse application rollback before production.

The default template activation gate, wildcard DNS/TLS provisioning, custom-domain verification and tenant-owned asset/form validation are unchanged.

## Clocks and measurements

`http_request.totalDurationMs` is **API request-context/middleware entry to Node response finish**. It includes middleware, handlers, encoding and response processing, not a remote client's DNS/TLS/round-trip measurement. Large streamed responses can be affected by write backpressure and have separate budgets. `Server-Timing: app` is explicitly **API middleware to response headers**, not finish. The two cannot be interchanged.

`responseBytes` is response body bytes handed to the Node response, excluding headers and unsent HEAD/204/304 bodies. BFF, browser transfer/compression bytes and decoded body bytes have their own labels. SQL, checkout, Redis, auth, external, handler and serialization spans can overlap; do not sum or subtract them to invent latency. Browser/CLI elapsed times include their own network hop and are reported separately.

Structured API JSON logs are enabled in production; use `PERFORMANCE_JSON_LOGS=true` in nonproduction when collecting staging evidence. Export `http_request` records from **every API replica**, preserving request IDs and the `api-middleware-to-finish` clock. Cloud Logging `jsonPayload` envelopes are accepted. The gate rejects missing/mismatched logs, non-2xx results, missing numeric metrics, insufficient samples, unverified cold resets and unobserved Redis faults. p95 is nearest rank; minimum 100 successful samples per endpoint/scenario is the initial gate. Agree sample size, load, duration, warm-up, dataset sizes and outage budgets before collecting a release baseline. Report failures separately, not as fast successes.

Targets are versioned in `scripts/performance/websiteBudgets.mjs`: warm host/status p50 <=50 ms and p95 <=100 ms; other warm reads p95 <=100 ms; cold bootstrap/editor/read targets initially p95 <=250 ms; ordinary validated writes p95 <=350 ms; services/launch/publish p95 <=1000 ms. These are proposed targets, not achieved measurements. Redis-outage p95 must be explicitly agreed via `PERF_OUTAGE_P95_MS`.

## Staging campaign

Use a nonproduction synthetic owner and isolated cache/database deployment. The runner never assumes an absent credential means a passing/skipped suite.

```sh
export PERF_STAGING_ACK=STAGING_ONLY
export PERF_API_URL=https://api.staging.example.com/api/v1
export PERF_ORIGIN=https://app.staging.example.com
export PERF_CANONICAL_HOST=synthetic.sites.staging.example.com
# Inject PERF_EMAIL and PERF_PASSWORD through the staging secret store.
export PERF_SAMPLES=100
export PERF_MIN_SAMPLES=100
export PERF_CONCURRENCY=8
export PERF_SCENARIOS=warm,concurrent
pnpm run perf:website:gate
```

Login/password hashing happens once outside the measured campaign. Authentication and tenant middleware still run on every measured request. The runner uses actual status/editor/overview/onboarding-services/bootstrap/dashboard/list/host-resolver routes. Initial recording normally exits nonzero until exported server logs and the full matrix are supplied; raw request records are still written. A client round trip is never substituted for missing server timing.

For cold runs, set `PERF_COLD_RESET_SCRIPT` to a reviewed local executable that resets **only the isolated staging deployment's** relevant caches (including process caches/restart when required). It must return exactly a JSON object with `scope:"isolated-staging"`, `reset:true`, and an auditable `evidenceId`. The runner executes it before each cold read; the host lookup also needs a logged application-cache miss. Appending a nonce is not a reset. No FLUSHDB/FLUSHALL command is embedded in this patch. Then record `PERF_SCENARIOS=cold` with `PERF_APPEND_REQUESTS=true` and the same `PERF_REQUESTS_PATH`.

For fault runs, use your deployment fault injector to disable **isolated staging Redis**, set `PERF_REDIS_OUTAGE_ACK=ISOLATED_REDIS_DISABLED`, `PERF_SCENARIOS=redis-outage`, and append the campaign. The gate requires actual Redis error observations, not just an environment label. Restore Redis and independently verify recovery/outbox draining, warm-cache suspension/expiry and correct public projection freshness. Never fault a shared production Redis.

Writes require `PERF_ALLOW_WRITES=STAGING_ONLY` and a reviewed `PERF_MUTATION_PLAN` JSON array. Each entry is one prepared, current-revision-valid `{method,path,body}` for editor, onboarding step/services, publish or launch. The runner does not synthesize business changes, guess revisions or retry stale DTOs until they succeed. Provision a representative tenant cohort and append their campaigns; each invocation authenticates its configured owner. Supply enough independent valid samples for every write endpoint. Parallel/lost-response correctness is checked separately with the existing launch/Studio browser suites and backend concurrency regressions; a fast 409 must not count as a successful write latency.

After collecting and exporting server logs:

```sh
export PERF_SERVER_LOGS_PATH=artifacts/api-http-request.jsonl
export PERF_OUTAGE_P95_MS=1000 # Example only: replace with the agreed outage target.
pnpm run perf:website:gate -- --evaluate
```

`releaseGatePassed` requires all configured endpoints plus warm/cold/concurrent/Redis-outage evidence for **each read endpoint**, successful planned write samples, complete matching finish logs and the agreed percentiles. This is the performance gate, not a replacement for typecheck, functional E2E, migration review or security checks.

## SQL plans and placement

```sh
pnpm run perf:website:explain -- --admin-id=REPLACE_WITH_REPRESENTATIVE_ADMIN_UUID > plans.json
export PERF_API_URL=https://api.staging.example.com
# Inject the existing PERFORMANCE_METRICS_TOKEN through the secret store.
pnpm run perf:website:topology
```

The plan tool runs reviewed SELECT-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` queries in a read-only transaction with lock/statement limits. It reports actual planning/execution time, root buffer counts (not double-counted descendants) and deployed index definitions. Use several representative tenant sizes, including catalogs over the UI limit. Compare actual application SQL plans too; the probe selects are representative diagnostic shapes, not a claim that every Prisma query has the same plan. Add a reviewed compound index only when measured filtering/order/cardinality warrants it; attach before/after evidence and reconcile against deployed migrations.

The topology tool samples the real API's existing protected pool/runtime/infrastructure endpoint under load. Optional `DATABASE_URL` and Redis host/port permit DNS/TCP probes from the diagnostic host; passwords/DSNs/IPs are not written to reports. Configure actual `PRIMARY_REGION`, `APP_REGION`, `DATABASE_REGION`, `REDIS_REGION`, `PROCESS_REGION` labels as already supported. Attach provider resource placement and network-route evidence: matching labels or one CLI TCP sample do **not** verify physical colocation. Investigate pool wait, connection reuse, capacity across replicas and event-loop delay before resizing the VM or pool.

## References consulted

- Prisma 7 driver-adapter pooling: https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool
- pg Pool checkout/release contract: https://node-postgres.com/apis/pool
- Next immediate tag expiry: https://nextjs.org/docs/app/api-reference/functions/revalidateTag

The patch does not upgrade libraries based on these documentation pages; the supplied lockfiles remain authoritative.
