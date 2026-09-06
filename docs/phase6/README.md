# Phase 6 backend patch

## Apply and qualification

Merge these project-relative changed/new paths into the supplied **Phase 5 backend**. This is not a complete checkout. Preserve all preceding migrations, the existing worker/outbox, template registries and the unchanged lockfile. Check `PATCH-MANIFEST.json` for prior/result SHA-256 values before overwriting locally modified files. There are no new schema migrations, no file deletions, no new dependency and no new queue.

**Not release-approved from this environment.** `VALIDATION.json` and the local TAP evidence describe what actually ran. Native behavioral tests, source contract checks, isolated typechecks and syntax checks passed. Dependencies could not be installed because registry name resolution was unavailable. Full generated-Prisma typechecking, Vitest, builds, live PostgreSQL execution, real Redis outage drills, staging browser traces, DNS/TLS verification, production reconciliation and deployment were **not executed**. No production records were inspected or repaired and no performance claim is made. The release workflow intentionally requires these external checks before rollout.

```sh
pnpm install --frozen-lockfile
pnpm run release:phase6
```

Use Node 22 and pnpm 11.5.1 as pinned by the project. CI retains PostgreSQL and Redis services and executes the complete existing security/integration/build gates; the new tests do not replace them.

## Security boundary

The access resolver no longer manufactures permissive results when the Prisma admin delegate is absent. That deployment error is a typed 503 configuration failure in every mode. Fixtures live explicitly in tests. Unknown account/lifecycle/subscription states deny access. Existing owner/staff roles, password hashing, tenant-owned assets/forms/services, origin/CSRF checks, upload limits and preview expiration remain in place.

Express strips internal routing headers before parsers/routes. Socket.IO independently strips them at its Engine.IO polling/upgrade entry, retaining its existing session authenticator. Public document authorization continues to use the website-bound URL and token, not a caller header.

Every public host result, **including a warm Redis hit**, crosses compact, request-memoized SQL authorization. The same fence protects direct public by-ID projection reads. SQL confirms current tenant lifecycle, owner/subscription state, website identity, publication status and committed revision. Cached aliases/custom domains re-prove their current binding. Missing or invalid publication revision fails closed rather than falling back to a draft. Projection envelopes require matching access identity/generation/deadline and committed revision; an old live envelope cannot bypass a suspension when invalidation delivery failed.

Access namespace v3 and route/projection envelope version 11 reject incompatible older entries. Epoch/CAS guards, bounded authorization deadlines, request memoization, truthful delivery outcomes, immediate publication readiness and the existing durable outbox remain. Redis failure degrades to SQL authorization, not allow-by-cache. Private caches retain their existing semantics. Routing safety depends on a current primary/consistent database read; do not silently send authorization queries to a lagging replica.

This adds real SQL work to warm public routing. Rebaseline Phase 5 warm/cold/concurrent/Redis-outage targets and pool/event-loop measurements in staging. A cached response is not evidence of a 50-100 ms browser or server percentile. Do not increase pool size or remove authorization to force an assumed target.

## Process and CI repair

The API entrypoint no longer starts the durable worker inline. Run `pnpm start:worker` as the existing separately supervised process. API restarts must not remove delivery recovery. The rollout requires `WORKER_DEPLOY_CMD` and `WORKER_VERIFY_CMD`, in addition to the API/frontend deployment commands. The verification command must check the candidate worker release and a healthy running process; an idle queue alone does not prove a worker is alive. Existing scheduler/bootstrap separation is unchanged. A single-process installation must provision the dedicated worker **before** applying this API change.

Two existing read-only audit/performance helpers now use tagged/parameterized Prisma SQL instead of the helpers rejected by the repository's reliability contract. This is a CI consistency repair, not a finding that SQL injection was demonstrated. `.env.example` credential-looking examples were replaced with explicit placeholders and the documented production access-token duration. This is sample-file hygiene, not a claim that any production credential was exposed. Generate and deploy unique real secrets separately; test/example values are not production configuration.

The backend workflow executes the new reconciliation SQL against its migrated disposable CI database. An empty CI report verifies SQL execution only; the production evidence gate explicitly rejects it as production reconciliation. Frontend CI separately verifies actual candidate deployment SHAs, both OTP configurations, native Chrome CDP, onboarding interface and old/new renderer matrices. Custom-domain testing stays separate.

Read `RELEASE.md` before any deployment and `REGRESSION-MATRIX.md` for test scope and remaining real-environment checks.
