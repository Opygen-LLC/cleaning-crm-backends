#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="${CLIENT_DIR:?Set CLIENT_DIR to the Cleaning CRM frontend checkout}"
: "${STAGING_DEPLOY_CMD:?Set STAGING_DEPLOY_CMD}" "${E2E_FRONTEND_URL:?}" "${E2E_API_URL:?}" "${E2E_TEST_TOKEN:?}"

echo '[phase7] frontend lint/typecheck/unit/build'
( cd "$CLIENT_DIR" && pnpm run lint && pnpm run typecheck && pnpm run test:unit && pnpm run build )

echo '[phase7] backend tests/typecheck/migration preflight/build'
( cd "$ROOT" && pnpm test && pnpm run typecheck && pnpm run db:migrate:preflight && pnpm run build )

echo '[phase7] deploy staging'
bash -lc "$STAGING_DEPLOY_CMD"

echo '[phase7] Playwright critical path against staging'
( cd "$CLIENT_DIR" && E2E_FRONTEND_URL="$E2E_FRONTEND_URL" E2E_API_URL="$E2E_API_URL" E2E_TEST_TOKEN="$E2E_TEST_TOKEN" pnpm run test:e2e:critical )

echo '[phase7] warm load smoke'
( cd "$ROOT" && pnpm run load:phase7:warm )
echo '[phase7] cold load smoke'
( cd "$ROOT" && pnpm run load:phase7:cold )

echo '[phase7] production MIG canary 5% -> 25% -> 100%'
exec "$ROOT/scripts/gcp/phase7-canary.sh"
