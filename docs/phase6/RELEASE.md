# Phase 6 release runbook

## 1. Qualify the exact candidates

Apply both overlays on Phase 5, inspect manifest base hashes, install the frozen dependencies, and run each repository's `release:phase6`. Do not bypass a failing test, missing browser or absent environment variable. Local TAP fixtures are not deployed evidence. Keep the old v1 renderers and v2 renderers available together. No template version is changed in tenant records by this patch.

Deploy the candidates to isolated staging before the frontend main/manual gate. Both `/api/version` and backend `/version` must expose the exact immutable commit SHA/build metadata. Configure the two OTP environments and disposable fixture/reset credentials described in the frontend README. Set `WEBSITE_TEMPLATE_V2_ENABLED=true` on staging to exercise explicit v2 selection; a v1 registration default can remain selected. Run native CDP suites with the installed Chrome path. Do not enable E2E hooks or short smoke-session lifetimes in production.

Run fault drills on isolated staging: warm a live tenant, block Redis/cache callback delivery, then suspend/archive/unpublish it and confirm the next canonical and app-host request denies access. Restore it, confirm current content, restart the API after a committed publication, and observe the **same** pending outbox row recover through the dedicated worker. Expire subscription/override boundaries while caches are warm. Verify expired preview tokens, staff owner-route denial and cross-tenant asset/form/catalog/page/domain references through real HTTP. Existing native/Vitest suites cover these boundaries at code/adapter level; real provider/database timing is a distinct qualification step. Record request IDs, SQL/Redis timings and revision/receipt outcomes without storing credentials.

## 2. Read-only production reconciliation

Use the candidate backend source and a least-privileged SELECT-only connection to the intended production database/schema. Confirm that target independently; a JSON report does not authenticate a database host. Set `RELEASE_GIT_SHA` to the full candidate backend SHA. Do not reuse the empty CI artifact or manufacture an evidence file.

```sh
pnpm run website:release:reconcile --ci \
  --output=artifacts/phase6/reconciliation.json \
  --batch-size=100 --max-websites=500000 --sample-limit=100
```

Supply `RELEASE_AUDIT_DATABASE_URL` through the secret environment. `DATABASE_URL` is a compatibility fallback, so verify it cannot point at staging accidentally. The database must expose the project's tables on its configured/default search path. The command establishes `REPEATABLE READ READ ONLY`, statement/lock/idle limits, keyset/cursor batches and bounded per-code samples. It refuses partial success when the inventory limit is exceeded. It does not enqueue work, invoke a backfill, invalidate caches, repair rows or alter the schema. A failing run removes the old output instead of leaving a stale successful report. Output permissions are private; IDs/findings remain sensitive operational data.

The report checks missing owner provisioning/default sites; completed onboarding without a valid publication; PUBLISHED rows without a valid immutable snapshot, timestamp and exact revision; divergence between publication and revision snapshots; unknown template/version/schema or component IDs/slots; canonical/alias/custom-host collisions; foreign/missing forms, managed images, page references and form catalog services; missing active services; counters behind history; malformed/duplicate legacy progress; delivery receipts; and unfinished migration metadata. Draft counters **ahead** of revision history can represent valid autosaves and are not automatically repaired.

Exit 0 means the command completed (with `--ci`, no error-level findings); 2 means findings block CI, and 1 means execution/configuration failure. Warnings require review too. Review the counts and bounded samples, get full scoped evidence for affected IDs, and prepare an explicit repair plan. Existing commands such as `provisioning:reconcile:dry-run`, `backfill:websites:dry-run`, the website migration dry-run, Phase 5 counter preflight and publication-delivery reconciler are candidates only when their invariant matches the finding. Some existing commands without `--dry-run` **write by default**. Never run them implicitly from this audit or mass-rewrite publication/template history. Re-run reconciliation after approved, separately executed repairs.

## 3. Platform wildcard and evidence bundle

Wildcard DNS/TLS is platform infrastructure, not per-registration work. The retained `scripts/release/provisionPlatformWildcard.mjs` verifies the existing Next.js project, base/wildcard domain assignments, DNS and a real TLS handshake at a random wildcard label. It is read-only by default; `--apply` changes provider assignments and requires separate approval. It does not migrate registrar/nameserver/mail records. For the supported Vercel-managed deployment, provide `WEBSITE_BASE_DOMAIN`, `PLATFORM_DNS_ZONE`, `PLATFORM_FRONTEND_PROJECT_ID`, `VERCEL_ACCESS_TOKEN` and optional team ID; write `PLATFORM_WILDCARD_REPORT` to the evidence directory. Missing readiness is a release blocker, not permission to simulate success. A different infrastructure provider needs equivalent reviewed verification rather than a forged Vercel report. Custom domains retain their separate ownership/routing/TLS lifecycle.

Collect actual reports from private, protected CI artifacts, preserving filenames and bytes:

```text
RELEASE_EVIDENCE_DIR/
  otp-enabled/clean.json
  otp-enabled/lost-response-retry.json
  otp-disabled/clean.json
  otp-disabled/lost-response-retry.json
  interface/interface-evidence.json
  studio/studio-1.0.0.json
  studio/studio-2.0.0.json
  studio/studio-2.0.0-custom.json       # required when custom domains are enabled
  reconciliation.json                # reviewed production read-only inventory
  platform-wildcard.json
  production-canary.json              # generated after deployment
```

The interface and Studio reports may be selected from either successful OTP environment, but must be from the same candidate SHAs. Retain the other environment's reports in CI for review. The CLI rejects missing, stale (over 24 hours), partial, failed, uncleaned, wrong-version and wrong-release reports. It requires both OTP scenarios, all four template families at both renderer versions, 101-plus catalog rows, phone/tablet/desktop accessibility/geometry and a nonempty complete production inventory. Custom-domain evidence becomes mandatory when `WEBSITE_CUSTOM_DOMAINS_ENABLED=true`.

```sh
pnpm run website:release:gate --stage=predeploy
```

Set `RELEASE_EVIDENCE_DIR`, `RELEASE_FRONTEND_SHA`, `RELEASE_BACKEND_SHA` and `WEBSITE_BASE_DOMAIN`. If reconciliation contains warnings, set `RELEASE_RECONCILIATION_REVIEW_SHA256` only after review, to the SHA-256 of the **exact** report bytes. This is an approval acknowledgment, not a repair. Reports and the digest are not cryptographically attested execution; restrict artifact writers, review protected-environment run provenance and do not accept operator-edited/fabricated reports. The gate does not itself deploy or set defaults.

## 4. Dependency-ordered rollout

Back up and verify recoverability before any separately required forward migration. This patch introduces no migration; earlier Phase 1-5 migrations remain required. Do not drop columns, rewrite snapshots or downgrade schema during a rolling deploy.

Deploy compatible backend API/cache fences and the existing dedicated worker first. Configure shared revalidation secrets and verified base-domain/app hosts. Require the worker supervisor to run the candidate release and retain its database-backed outbox rows across restart. Run API readiness, existing operational monitors and worker verification. Drain old backend instances before relying on the new boundary; mixed old instances can still serve the old policy. Keep routing fail-closed or maintenance-gated while this security boundary is incomplete.

Deploy the frontend/BFF/state changes and all retained/new template renderers/assets next. Drain old unsigned-hint-trusting frontend instances and purge any legacy external full-page CDN cache that ignored no-store. Keep Next publication revalidation immediate (`expire: 0`). Verify old published sites remain on their original template/version and manual v2 selections use the same renderer for preview and public pages.

The existing `release:production` script now checks the evidence before production mutation, runs the complete source gates with E2E variables removed, retains backups/forward-migration checks and operational smokes, refreshes a read-only audit after migrations, deploys API then dedicated worker then frontend, and runs the read-only canary before declaring default activation eligible. All deployment, reset, backup, worker verification and rollback commands are explicit operator configuration; none ran in this delivery. `APPLICATION_ROLLBACK_CMD` must cover compatible API, worker and frontend artifacts, not delete customer data.

## 5. Small read-only production canary

Prepare a private JSON array of two to five **already provisioned** approved canary tenants. Include a live tenant with its expected committed revision and an unpublished or suspended tenant. Each record has `websiteId`, `tenant` (canonical platform label), `state` (`live`, `unpublished` or `suspended`), `publicUrl` (its exact HTTPS platform host), and `revision` for live entries. Do not insert fake UUIDs or use unrelated customer hosts. Prefer a live retained-v1 site and live v2 site plus a denied site. Registration and destructive lifecycle drills belong in staging, not in this read-only production command.

```sh
pnpm run website:release:canary
pnpm run website:release:gate --stage=activate
```

Set `RELEASE_CANARY_COHORT` to that file, `PRODUCTION_FRONTEND_URL` and `PRODUCTION_API_ORIGIN` to HTTPS origins, and the release/evidence variables above. The canary sends only GETs: actual version endpoints, canonical and app-host `/site` routes twice each with forged internal hints, and backend by-ID reads. It verifies expected denial or exact website/revision, no-store page headers and deployed SHAs. The two reads are first/repeat probes, not proof that caches were forcibly cold/warm; inspect monitoring for that distinction. The command does not change a tenant's status, publish, create an account or reset fixtures.

Only after all evidence, real fault drills, operational health and canary review pass should a separate configuration rollout permit new v2 selections and then set `WEBSITE_DEFAULT_TEMPLATE_VERSION=2.0.0`. Keep `WEBSITE_TEMPLATE_V2_ENABLED=true` when the default is 2.0.0. Activating a default affects new provisioning only; existing publications are not migrated. The script never changes these flags automatically. Do not mistake the activation gate's JSON for execution of that configuration change.

## 6. Rollback and watchpoints

Rollback application images/configuration only, to releases that understand current additive contracts, signed routing and all already-published template versions. Do not restore an old unsigned-header trust vulnerability. If necessary hold traffic closed while producing a compatible rollback build. Turning the registration default back to 1.0.0 stops new v2 defaults; it must not remove the v2 renderer or republish existing v2 customers as v1. Retain snapshots, revision counters, ownership data and pending outbox rows. No automatic reverse migration or customer deletion is permitted.

Monitor auth/session 401/403/5xx, host/projection errors, denied-route behavior, callback delivery and queue age/retries/leases, first canonical request revision, pool wait, event-loop delay and Redis recovery. A live URL string or an empty queue does not establish readiness. Abort broader rollout on stale publication, leaked denied content, lost newer drafts, navigation loops, failed reconciliation or missing worker recovery. Keep the previous compatible artifacts and the backup until the cohort and wider rollout are reviewed.
