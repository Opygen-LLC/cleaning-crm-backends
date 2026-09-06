# Phase 2: atomic onboarding saves and publication boundaries

## Apply this patch

Overlay this archive at the **backend repository root, after the Phase 1 backend patch**. Paths are relative to that root. The paired frontend patch requires this backend version. Do not replace the entire repository with this delta archive. `PATCH-MANIFEST.phase2.json` records the previous and updated hashes of each changed file. No dependencies, lockfiles, database schema, or database migrations were added. No second queue was introduced. The existing Phase 1 transactional launch/publication outbox remains in place.

Deploy backend first. The default bootstrap response remains the strict v1 shape for existing clients; the new frontend explicitly requests v2. Existing services and milestone endpoints remain available. The legacy `template` milestone normalizes to `review_launch`; the visible flow remains five steps.

## Verification status -- not a production deployment certificate

Locally executed: **35 backend native behavioral tests passed** (19 retained Phase 1 launch regressions plus 16 Phase 2 tests), with no skips. TypeScript transpilation/syntax diagnostics: **504 backend source/test modules, zero syntax errors**. The native harness executes production service functions with explicit transactional database/cache adapters, not a live PostgreSQL server. HTTP Zod validation and booking provisioning have fixture adapters in that harness; separate real-Zod contract tests are included for the installed-dependency gate.

Full dependency-aware typechecking, Prisma generation/validation, Vitest contract tests, production builds, real PostgreSQL concurrency tests, and browser/staging end-to-end runs **were not verified in this environment**. Repository dependencies and the generated Prisma client were unavailable, and package downloads were blocked. Direct `tsc --noEmit` stopped on missing Node type definitions. No staging credentials or live environment were supplied; no staging traces, timings, or successful deployment are claimed. Review `verification.json` and the native TAP report. Run the release gate below before deploying.

```sh
# Use the repository-pinned package manager and an environment with PostgreSQL/Redis configuration.
pnpm install --frozen-lockfile
pnpm run release:phase2
# Also run the complete existing release check in the normal release environment.
pnpm run release:check
```

## Versioned contract

`GET /api/v1/admin/bootstrap?surface=onboarding&schemaVersion=2` returns a compact bootstrap with `schemaVersion: 2`, `adminId`, `profileVersion`, favicon, template version and both revision counters. Omitting the version or requesting `1` retains the previous shape.

`GET /api/v1/admin/onboarding/services` returns an uncached, identity-scoped v2 context. Its catalog is **complete**, not a page. Catalog, booking configuration, profile, website revision and progress are read under the same transaction/locks.

`PUT /api/v1/admin/onboarding/step` accepts profile, branding, address or services commands. `PUT /api/v1/admin/onboarding/services` accepts the same v2 services command and the previous v1 payload. Every v2 request supplies `schemaVersion: 2`, the owned `websiteId` and `expectedRevisionNumber` (zero is a real precondition). Step-specific fields are:

- `business_profile`: `expectedProfileVersion` and a partial `profile`. Omission means unchanged; null clears nullable fields. `postcode` maps to stored `zipcode`; a conflicting pair is rejected. Phone numbers normalize to international E.164. Existing currency/timezone are not replaced with browser defaults.
- `branding`: a narrow `branding` patch for colors, font, logo and favicon. All non-null logo/favicon references must be registered immutable managed assets for this website and the correct slot. Persistence, milestone and revision commit together.
- `services`: `catalogVersion`, explicit `services` upserts, `deactivateServiceCatalogIds` and booking presentation/configuration. Existing rows require `serviceCatalogId`. Unchanged rows need not be sent. An omitted add-on array preserves it; `[]` clears it. Omitted services are never deleted/deactivated, including legacy clients. Each change-set list has a 2,000-item safety limit; this is not a catalog-read limit.
- `website_address`: canonical `subdomain`; existing alias/reservation lifecycle is reused inside the transaction.

All v2 saves return `schemaVersion`, `userId`, `adminId`, `step`, `replayed`, `draftRevisionNumber`, **the persisted `bootstrap`**, `onboarding`, `nextStep`, and nullable `catalog`/`bookingSetup` (populated for services). The returned revision/progress/fields are read before that transaction commits, not assembled from later independent GETs.

Frontend DTOs and Zod 3 parsers are independent of backend Zod 4. `tests/fixtures/onboarding-v2.json` is an identical JSON wire fixture in both patches; it is test data, not a shared runtime schema.

## Atomicity, replay and concurrency

The lock order is website advisory lock, owner row lock, optional booking lock, then catalog lock. Every supported catalog writer and booking-default creator uses the catalog lock. Progress writes reread under the website/owner lock and replace a normalized set rather than pushing duplicate milestones.

A profile token catches profile changes outside Website Studio. A complete-catalog fingerprint includes stable IDs, displayed values, add-ons and update timestamps, so another tab's creation, update or deletion rejects the entire stale command with `ONBOARDING_CATALOG_CONFLICT`. Website editor revision checking also guards the combined save.

The existing immutable `WebsiteRevision.reason` stores `Onboarding v2:<step>:<request hash>` as the durable replay receipt. Expected versions are part of that hash. Retrying the exact request after a lost response does not mutate again, even after a later deliberate save; it returns the current authoritative result with `replayed: true`. No new idempotency table/queue is required. Cache failures after commit do not erase the receipt or turn a draft save into publication readiness.

The deprecated v1 `authoritativeSelection` behavior is deliberately non-destructive: omission no longer authorizes deactivation. An old client cannot safely express complete-catalog deletion; use v2 explicit removals. Historical `priceGbp` add-on JSON normalizes to `price` on read. Malformed saved add-on data fails closed with `SERVICE_ADDONS_DATA_INVALID`, rather than silently replacing it with an empty array.

## Staging acceptance before release

Use disposable tenants and the existing request/client monitoring helpers. Keep request IDs and SQL/Redis measurements from the actual run; do not substitute the adapter-test timings.

1. Save every profile/branding field, reload, navigate backward, clear each nullable field, reload again. Confirm returned bootstrap and persisted rows, including favicon/font, currency, timezone and both postal-code spellings. Reject a foreign logo/favicon and foreign booking form with no partial writes.
2. Seed more than 100 catalog rows, including inactive services and add-ons with zero prices. Edit one service and deselect another; confirm all other rows and add-ons survive. While a second tab adds/changes a service, submit an old context and require a 409 without any booking/progress/revision changes.
3. Race identical step requests over separate PostgreSQL connections. Confirm one receipt/revision and no duplicate milestone. Interrupt after commit and retry the exact request; then repeat after a later save and confirm it does not undo newer data.
4. Exercise the paired Studio tests with a delayed save and delayed publish, including edits during both windows, a double click and a lost publish response. Only the click-time revision may publish; later edits must remain dirty and save afterward. Re-run all Phase 1 launch/first-host/navigation regressions.

Rollback frontend before backend. Keep the compatible backend for clients that already requested v2; preserve revisions, completed progress and publication outbox work. Do not run destructive data repairs or reset a tenant's progress as rollback.
