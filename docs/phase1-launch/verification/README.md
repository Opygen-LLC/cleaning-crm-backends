# Verification evidence

`baseline-backend.tap` and `baseline-frontend.tap` preserve four expected failures
against the original uploaded production source. `patched-behavior.tap` is the
passing local suite for this repository. Both use the patched test harness and
real production exports with explicit I/O adapters. These are not staging traces.

`combined-typescript-syntax.json` checks syntax only across both repositories;
it does not resolve imports or validate types. `typecheck-blocked.txt` records the
dependency blocker, not a passing typecheck. Other files record only the named
source/hygiene checks. See `verification.json` for the complete scope and explicit
unverified gates, and the root `PHASE1_LAUNCH_README.md` for release instructions.

No clean or failed live-staging trace was fabricated. Run the supplied frontend
capture script in your staging environment to collect that evidence.
