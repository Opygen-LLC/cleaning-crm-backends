#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="${CLIENT_DIR:?Set CLIENT_DIR to the Cleaning CRM frontend checkout}"
: "${STAGING_DEPLOY_CMD:?Set STAGING_DEPLOY_CMD}"
: "${E2E_FRONTEND_URL:?Set E2E_FRONTEND_URL}"
: "${E2E_API_URL:?Set E2E_API_URL}"
: "${E2E_TEST_TOKEN:?Set E2E_TEST_TOKEN}"
: "${E2E_ACCESS_TOKEN_TTL_SECONDS:?Set E2E_ACCESS_TOKEN_TTL_SECONDS}"
: "${PERFORMANCE_METRICS_TOKEN:?Set PERFORMANCE_METRICS_TOKEN}"
: "${STAGING_DATABASE_URL:?Set STAGING_DATABASE_URL for the staging integrity gate}"
: "${PRODUCTION_DATABASE_URL:?Set PRODUCTION_DATABASE_URL for pre/post-migration integrity gates}"
: "${PRODUCTION_BACKUP_CMD:?Set PRODUCTION_BACKUP_CMD to a verified database backup/snapshot command}"
: "${PRODUCTION_MIGRATION_CMD:?Set PRODUCTION_MIGRATION_CMD to the production prisma migrate deploy command}"
: "${CANARY_SMOKE_CMD:?Set CANARY_SMOKE_CMD to target the new canary release directly}"
: "${CANARY_MONITOR_CMD:?Set CANARY_MONITOR_CMD to check the canary monitoring endpoint directly}"

run_e2e() {
  ( cd "$CLIENT_DIR" && \
    E2E_FRONTEND_URL="$E2E_FRONTEND_URL" \
    E2E_API_URL="$E2E_API_URL" \
    E2E_TEST_TOKEN="$E2E_TEST_TOKEN" \
    E2E_TEST_EMAIL_DOMAIN="${E2E_TEST_EMAIL_DOMAIN:-e2e.invalid}" \
    E2E_TEST_PASSWORD="${E2E_TEST_PASSWORD:-Smoke!Test123}" \
    E2E_ACCESS_TOKEN_TTL_SECONDS="$E2E_ACCESS_TOKEN_TTL_SECONDS" \
    pnpm run test:e2e:smoke )
}

echo '[release] frontend type/lint/unit/integration/build qualification'
( cd "$CLIENT_DIR" && pnpm install --frozen-lockfile && pnpm run release:check )

echo '[release] backend schema/type/unit/integration/security/build qualification'
( cd "$ROOT" && pnpm install --frozen-lockfile && pnpm prisma validate && pnpm run release:check )

echo '[release] deploy production-equivalent staging'
bash -lc "$STAGING_DEPLOY_CMD"

echo '[release] staging data-integrity gate after staging migrations'
( cd "$ROOT" && DATABASE_URL="$STAGING_DATABASE_URL" pnpm run data:audit:ci )

echo '[release] real-browser staging smoke + live frontend/backend contract checks'
run_e2e

echo '[release] staging monitoring must be healthy'
( cd "$ROOT" && API_URL="${STAGING_API_ORIGIN:-${E2E_API_URL%/api/v1}}" PERFORMANCE_METRICS_TOKEN="$PERFORMANCE_METRICS_TOKEN" pnpm run monitoring:alerts )

echo '[release] migration dry-run / drift / reconciliation report (no writes)'
( cd "$ROOT" && pnpm run db:migrate:preflight && pnpm run db:drift:check && pnpm run db:reconcile )

echo '[release] production data-integrity gate before schema mutation'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run data:audit:ci )

echo '[release] create and verify production database backup before schema mutation'
bash -lc "$PRODUCTION_BACKUP_CMD"

echo '[release] deploy production migrations only after backup succeeds'
bash -lc "$PRODUCTION_MIGRATION_CMD"

echo '[release] verify auth-session hardening schema and drift after migrations'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:auth-session:verify && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:drift:check )

echo '[release] production data-integrity gate after migrations'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run data:audit:ci )

echo '[release] 5% -> 25% -> 100% canary; each stage runs browser smoke and monitoring gates'
export CANARY_SMOKE_CMD CANARY_MONITOR_CMD
exec "$ROOT/scripts/gcp/phase7-canary.sh"
