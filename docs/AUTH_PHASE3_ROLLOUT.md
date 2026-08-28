# Auth Phase 3 Production Rollout

Deploy backend before frontend. Do not deploy the verification UI against an older auth response contract.

## 1. Backend preflight

Run in CI/staging:

```bash
pnpm install --frozen-lockfile
pnpm run release:auth:phase3:verify
```

Production runtime must have the Phase 2 auth topology configured, including the live frontend/API origins, shared cookie parent domain, and `ACCESS_TOKEN_EXPIRES_IN=15m`.

## 2. Deploy backend and verify health

Deploy the backend first, then verify `/livez`, `/readyz`, and `/health` according to your existing monitoring policy.

Run the controlled auth smoke test with a verified ACTIVE smoke-test account. Do not use a personal/admin owner account:

```bash
AUTH_SMOKE_API_URL=https://api.opygen.com/api/v1 \
AUTH_SMOKE_EMAIL='auth-smoke@example.com' \
AUTH_SMOKE_PASSWORD='...' \
pnpm run smoke:auth:phase3
```

The smoke script validates login, `/auth/me`, refresh and logout without printing credentials or cookie values.

## 3. Deploy frontend

After the backend smoke test passes, deploy the frontend.

## 4. Run real browser auth qualification in staging

The Playwright suite uses the staging-only E2E hook only to read the generated OTP and inspect/clean synthetic data. It does **not** call `/auth/verify-email` or `/auth/login` directly.

```bash
E2E_FRONTEND_URL=https://staging-cleaningcrm.opygen.com \
E2E_API_URL=https://staging-api.opygen.com/api/v1 \
E2E_TEST_TOKEN='...' \
pnpm run test:e2e:auth
```

The suite qualifies registration → OTP UI → Personalize Website → onboarding, browser logout/login, wrong-password behavior, reload persistence, silent refresh, cookie contracts and logout cleanup.

## 5. Production observation

Watch auth request logs using `requestId`, `traceId`, `route`, `statusCode`, `authErrorCode`, and `releaseSha`. Never add password, OTP, cookie, access-token, refresh-token or session-token values to logs.

Rollback the frontend first if browser qualification fails after rollout. Roll back the backend only if the backend smoke/auth contract itself is failing.
