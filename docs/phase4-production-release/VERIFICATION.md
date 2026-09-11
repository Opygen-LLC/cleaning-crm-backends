# Phase 4 verification record

This archive contains the final Cleaning CRM Phase 4 source changes plus both dependency-free release checks and the repository's dependency-aware production gate.

## Checks completed in the source-build environment

The following checks passed against the final Phase 4 backend source:

- Phase 4 Cleaning CRM production contracts: **12/12 passed**.
- Focused Phase 1-3 Reviews/Subscription/Services regressions: **21/21 passed**.
- Phase 8 website rollout contract: **5/5 passed**.
- Cloudflare R2 Phase 2/3 regression contracts: **19/19 passed**.
- Repository hygiene, production cleanup, secret safety, reliability, Phase 3 runtime, Phase 4 production, Phase 5 production/security, Phase 6 observability/auth, and Phase 8 rollout source gates: **passed**.
- The Phase 4 source gate specifically covers review UUID/body/date validation, review source-relation tenant isolation, public review entitlement alignment, service pagination and validation, billing-history validation, log redaction, production access-token TTL, environment-secret safety, R2 hard-delete completion behavior, and the durable publication-delivery architecture.

A syntax-only parse of the complete TypeScript source tree is also run before packaging. Dependency-aware type checking remains part of the normal release command below.

## Dependency-aware release gate

The supplied source archive intentionally does not contain `node_modules` or generated Prisma runtime files. In the packaging environment, registry access was unavailable, so it was not possible to install the locked dependencies and truthfully run Prisma generation, the complete Vitest integration suite, `tsc --noEmit`, or the final `tsup` build there.

Run this in CI/staging with registry access:

```bash
pnpm install --frozen-lockfile
pnpm run release:phase4:cleaning-crm
```

The repository's `release:check` then runs Prisma generation/validation, security and integration suites, TypeScript checking, the complete test suite, and the production backend build.

## Staging-only checks

Authenticated browser and database-backed staging verification requires deployed staging URLs, production-equivalent infrastructure, and disposable tenant credentials, so it cannot be represented honestly by source-only tests. Run the smoke matrix in `README.md` in this folder before production promotion.

Do not promote a release if the dependency-aware gate or staging smoke matrix fails.
