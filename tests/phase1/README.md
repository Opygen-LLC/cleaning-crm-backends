# Phase 1 behavioral regressions

Run `pnpm run test:phase1:launch` from the repository root after installing the
original lockfile dependencies. The harness uses the existing TypeScript package
and Node's test runner; it does not add a test framework or require secrets.

`load-source.cjs` executes the real modified source with explicit doubles. These
are unit/model regressions, not PostgreSQL, Redis Lua, React rendering, or browser
integration tests. Backend model time advances explicitly so expiry assertions
are deterministic. Never interpret model execution duration as API latency.

See `PHASE1_PATCH.md` for the baseline command, current verification results,
staging capture runner, infrastructure assumptions, and required release gates.
Do not substitute these tests for the existing Vitest/build/lint suites or the
two real staging traces.
