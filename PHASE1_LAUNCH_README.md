# Phase 1: launch correctness patch

## Delivery and verification status

This is an overlay of changed/new files, not a replacement repository. Extract
this archive into the corresponding original repository root, preserving paths.
Keep all unchanged files, the existing lockfile and your own environment
configuration. No credentials, dependencies, generated Prisma client, database
migration, or build outputs are included. `PHASE1_PATCH_MANIFEST.json` records
SHA-256 hashes against the exact uploaded archive and the resulting files.

The code and executable behavioral regressions are implemented. **Production
readiness has not been certified in this environment.** Project dependencies and
service credentials were unavailable; dependency installation could not complete
because container network/DNS access was unavailable. Full semantic typechecking,
full Vitest suites, application builds and real PostgreSQL/Redis integration tests
must pass in your release environment before deployment. Syntax checks and tests
with I/O fixtures are not substitutes for those gates.

**No staging registration/launch traces were captured and no DNS/TLS changes were
applied.** A staging capture runner and a separate one-time platform provisioning
runner are provided. There are no fabricated successful staging traces in this
archive. The TAP evidence in `docs/phase1-launch/verification/` is local behavioral
test output, not production traffic or staging evidence.

## Four preserved regressions

| Regression | Original uploaded source | Patched source |
| --- | --- | --- |
| R1: cached DRAFT access, launch, first canonical host read | FAIL (backend baseline TAP) | PASS (backend behavioral suite) |
| R2: completion effect replay issues one dashboard replace | FAIL (frontend baseline TAP) | PASS (frontend behavioral suite) |
| R3: concurrent launch with the same expected revision | FAIL (backend baseline TAP) | PASS (backend behavioral suite) |
| R4: lose the response after commit, retry the original revision | FAIL (backend baseline TAP) | PASS (backend behavioral suite) |

The tests execute real production TypeScript exports with explicit in-memory I/O
adapters. They do not prove real database lock behavior, Redis script semantics
under a cluster, browser routing, DNS propagation, or external TLS availability.
The staging runner exercises browser registration through launch and the first
external canonical-host HTML request separately.

After installing the unchanged dependency lockfile, run `pnpm run
test:phase1:launch`. The existing `release:check` now runs these regressions first.
The original-source regression comparison can be reproduced from the patched
repository using `PHASE1_SOURCE_ROOT=/absolute/path/to/original/repository` with
`node --test tests/launch/launch-regressions.test.cjs` on the backend or
`node --test tests/launch/navigation.behavior.test.cjs` on the frontend. Keep the
fixture/test files from this patch; point only the production-source root at the
original source. Those baseline commands are expected to fail.

## Safe deployment order

1. Freeze launch/publication traffic and drain/stop old outbox workers. Deploy
   the updated worker first; it understands both the legacy callback-only
   payload and the version-1 publication delivery extension of the same topic.
   **Do not let an old worker consume the new delivery payload:** it can otherwise
   acknowledge a frontend callback without performing backend readiness work.
2. Deploy the updated backend API/scheduler and then the updated frontend. Avoid
   overlapping old/new API cache writers while launching sites. Complete the
   platform DNS/TLS check and verify the existing signed revalidation callback
   is configured and reachable with matching secrets.
3. Run full release checks and the two real staging traces; enable launch traffic
   only after they pass. Retain the existing worker and scheduler processes and
   monitor pending/retry/dead outbox rows and delivery warnings.

No schema change is required: the existing outbox topic, JSON payload, unique
`dedupeKey`, attempts/lease/retry fields are reused. Do not flush shared Redis.
New access/routing/projection namespaces safely bypass incompatible old cache
entries. The access generation key intentionally does not expire independently
of data: deleting it while requests are active can reintroduce an ABA race.
Do not downgrade workers while versioned delivery rows remain. Prefer roll-forward;
freeze publication and drain compatible delivery work before any rollback.

## Backend implementation

Publication still commits the immutable snapshot, revision and
`onboardingCompletedAt` in the existing advisory-lock transaction. The review
milestone and a deduplicated outbox delivery row now commit in that transaction.
An outbox insert failure rolls back the entire publication. An already completed,
published launch is checked before the expected-draft-revision conflict, so a
lost response, a double click or a later retry cannot implicitly publish a newer
draft or create another launch revision. Callers that completed review separately
remain supported.

After commit, the immediate delivery path rotates the tenant access epoch before
invalidating route/projection entries or invoking the signed Next callback. An
in-flight old access lookup cannot install its result into the new epoch.
Routing, fresh projection and stale projection validity are bounded by the
absolute subscription/override decision horizon, including TTL jitter. Suspension,
restoration and publication use the ordered path. Expiry updates are conditional
inside a transaction so a concurrently renewed subscription is not expired by an
old scan. Reads recheck the epoch/deadline around slow work.

The existing `PUBLIC_WEBSITE_CACHE_INVALIDATION_REQUESTED` topic carries an
optional `delivery: {version: 1, adminId, revision}` extension. Publication uses
`website-publication:<websiteId>:<revision>` for deduplication; lifecycle events
use independent deduplication keys within the same outbox, not another queue.
Immediate work and retry workers execute the same delivery implementation. Worker
receipt updates are fenced by processing status and attempt count. Failed access
invalidation, Next revalidation, host verification or warming remain retryable;
none is reported as confirmed readiness. A committed but preparing publication
may still complete onboarding and navigate to the dashboard safely.

Readiness verifies the platform host, its canonical host, the database revision,
the public projection revision, actual Redis warming, and the current access
horizon. `delivered` is deliberately different from `ready`: a suspended site can
be successfully invalidated but is not live. Redis/Next outages produce preparing
or unavailable status instead of a false ready flag. The compact authenticated
`GET /website/status` is no-store and does not load dashboard analytics.

The launch controller returns a versioned completion envelope with the canonical
session, user/organization identity, onboarding status, bootstrap and compact
website status. It records requestTrace identifiers, SQL count/time, Redis time
and revision in `website_launch_completion` logging without session credentials.
The public projection includes `publishedRevisionNumber`, and missing committed
snapshots fail closed instead of falling back to an older revision.

## One-time platform wildcard DNS/TLS

The new runner is an administrative operation, not part of registration or launch:

```sh
export WEBSITE_BASE_DOMAIN=sites.example.com
export PLATFORM_DNS_ZONE=example.com
export PLATFORM_FRONTEND_PROJECT_ID=prj_REPLACE_WITH_FRONTEND_PROJECT
export VERCEL_ACCESS_TOKEN='LOAD_FROM_SECRET_MANAGER'
# Set VERCEL_TEAM_ID for a team project when required.
export PLATFORM_WILDCARD_REPORT=/secure/release/platform-wildcard.json
node scripts/release/provisionPlatformWildcard.mjs
# Review the dry-run, then explicitly apply:
node scripts/release/provisionPlatformWildcard.mjs --apply
```

Replace the example values; do not store real tokens in this archive or source
control. This runner supports the existing Vercel/Next.js deployment. It validates
the frontend project, adds only the base and wildcard project domains when absent,
checks ownership, then performs a random-label DNS and trusted TLS/SNI probe.
Reruns are safe. It refuses existing redirects or branch/custom-environment
bindings. Pending propagation or ownership verification is not successful
readiness. It never touches tenant custom-domain verification.

Managed wildcard TLS requires Vercel-authoritative nameservers. The script
requires existing safe zone delegation and intentionally does not migrate your
registrar or existing mail/DNS records. Migrate all required records and verify
ownership before applying; otherwise it fails without making that change. Use
one platform operation per environment, not one operation per tenant. For another
hosting provider, configure and verify the equivalent wildcard at that provider;
this script does not provision non-Vercel infrastructure.

Provider references (API versions and DNS prerequisite):
- https://vercel.com/docs/rest-api/sdk/projects/add-a-domain-to-a-project
- https://vercel.com/docs/rest-api/projects/get-a-project-domain
- https://vercel.com/docs/domains/working-with-nameservers
- https://vercel.com/docs/platforms/multi-tenant-platforms/configuring-domains

## Required release gates

Install the existing lockfile with your normal supported pnpm/Node toolchain,
then run `pnpm run test:phase1:launch`, `pnpm run
test:phase1:launch:integration`, `pnpm run typecheck`, and the full existing
`pnpm run release:check`. Run database/Redis integration coverage with real
services: concurrent launches, expiry/suspension during lookup, epoch CAS, an
outbox lease takeover, and a process termination after commit before delivery.
Adapted Vitest tests are included, but were not executed in the delivery container.

Use the frontend archive's `scripts/e2e/phase1-launch-traces.mjs` against staging
with the existing backend E2E hooks and monitoring enabled. Confirm real clean and
lost-response traces, a ready wildcard report, matching revalidation secrets,
working workers/scheduler, and no unaddressed dead publication delivery rows.
