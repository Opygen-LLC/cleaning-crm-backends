#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="${CLIENT_DIR:?Set CLIENT_DIR to the Cleaning CRM frontend checkout}"
: "${STAGING_DEPLOY_CMD:?Set STAGING_DEPLOY_CMD}" "${E2E_FRONTEND_URL:?}" "${E2E_API_URL:?}" "${E2E_TEST_TOKEN:?}" "${E2E_ACCESS_TOKEN_TTL_SECONDS:?}" "${PERFORMANCE_METRICS_TOKEN:?}"

echo '[phase7] frontend static/unit/build qualification'
( cd "$CLIENT_DIR" && pnpm install --frozen-lockfile && pnpm run release:check )

echo '[phase7] backend schema/tests/security/build qualification'
( cd "$ROOT" && pnpm install --frozen-lockfile && pnpm prisma validate && pnpm run release:check && pnpm run db:migrate:preflight )

echo '[phase7] deploy production-equivalent staging'
bash -lc "$STAGING_DEPLOY_CMD"

echo '[phase7] Playwright real-browser critical path against staging'
( cd "$CLIENT_DIR" && E2E_FRONTEND_URL="$E2E_FRONTEND_URL" E2E_API_URL="$E2E_API_URL" E2E_TEST_TOKEN="$E2E_TEST_TOKEN" E2E_TEST_EMAIL_DOMAIN="${E2E_TEST_EMAIL_DOMAIN:-e2e.invalid}" E2E_TEST_PASSWORD="${E2E_TEST_PASSWORD:-Smoke!Test123}" E2E_ACCESS_TOKEN_TTL_SECONDS="$E2E_ACCESS_TOKEN_TTL_SECONDS" pnpm run test:e2e:smoke )

echo '[phase7] monitoring alert gate'
( cd "$ROOT" && API_URL="${STAGING_API_ORIGIN:-${E2E_API_URL%/api/v1}}" PERFORMANCE_METRICS_TOKEN="$PERFORMANCE_METRICS_TOKEN" pnpm run monitoring:alerts )

echo '[phase7] warm load smoke (primary-region baseline)'
( cd "$ROOT" && TEST_ENVIRONMENT=staging-primary-region pnpm run load:staging:warm )
echo '[phase7] cold load smoke (primary-region baseline)'
( cd "$ROOT" && TEST_ENVIRONMENT=staging-primary-region pnpm run load:staging:cold )

echo '[phase7] production canary 5% -> 25% -> 100%'
exec "$ROOT/scripts/gcp/phase7-canary.sh"
