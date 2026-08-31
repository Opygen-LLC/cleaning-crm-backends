#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="${CLIENT_DIR:?Set CLIENT_DIR to the Cleaning CRM frontend checkout}"
: "${PRODUCTION_DATABASE_URL:?Set PRODUCTION_DATABASE_URL}"
: "${PRODUCTION_BACKUP_CMD:?Set PRODUCTION_BACKUP_CMD to a verified backup/snapshot command}"
: "${BACKEND_DEPLOY_CMD:?Set BACKEND_DEPLOY_CMD}"
: "${FRONTEND_DEPLOY_CMD:?Set FRONTEND_DEPLOY_CMD}"
: "${APPLICATION_ROLLBACK_CMD:?Set APPLICATION_ROLLBACK_CMD to roll back application releases only}"
: "${PRODUCTION_API_ORIGIN:?Set PRODUCTION_API_ORIGIN, e.g. https://api.example.com}"
: "${PRODUCTION_FRONTEND_URL:?Set PRODUCTION_FRONTEND_URL, e.g. https://cleaningcrm.example.com}"
: "${AUTH_SMOKE_EMAIL:?Set AUTH_SMOKE_EMAIL to a non-destructive production smoke account}"
: "${AUTH_SMOKE_PASSWORD:?Set AUTH_SMOKE_PASSWORD}"
: "${PERFORMANCE_METRICS_TOKEN:?Set PERFORMANCE_METRICS_TOKEN}"
: "${FRESH_DB_TEST_DATABASE_URL:?Set FRESH_DB_TEST_DATABASE_URL to a disposable empty CI database}"
: "${E2E_FRONTEND_URL:?Set E2E_FRONTEND_URL to production-equivalent staging}"
: "${E2E_API_URL:?Set E2E_API_URL to staging /api/v1}"
: "${E2E_TEST_TOKEN:?Set E2E_TEST_TOKEN for staging-only hooks}"
: "${E2E_ACCESS_TOKEN_TTL_SECONDS:?Set E2E_ACCESS_TOKEN_TTL_SECONDS (1..120) on staging}"
: "${E2E_ADMIN_EMAIL:?Set E2E_ADMIN_EMAIL}"
: "${E2E_ADMIN_PASSWORD:?Set E2E_ADMIN_PASSWORD}"
: "${E2E_STAFF_EMAIL:?Set E2E_STAFF_EMAIL}"
: "${E2E_STAFF_TEMP_PASSWORD:?Set E2E_STAFF_TEMP_PASSWORD}"
: "${E2E_FIXTURE_RESET_CMD:?Set E2E_FIXTURE_RESET_CMD to restore staging admin/staff smoke fixtures}"

API_ORIGIN="${PRODUCTION_API_ORIGIN%/}"
FRONTEND_ORIGIN="${PRODUCTION_FRONTEND_URL%/}"
MIGRATIONS_APPLIED=0
DEPLOY_STARTED=0

rollback_application_only() {
  local exit_code=$?
  if [[ "$DEPLOY_STARTED" == "1" ]]; then
    echo '[release] failure after deployment began; rolling back application release only' >&2
    echo '[release] database migrations are forward-only and will NOT be automatically reversed' >&2
    bash -lc "$APPLICATION_ROLLBACK_CMD" || echo '[release] WARNING: application rollback command failed' >&2
  fi
  exit "$exit_code"
}
trap rollback_application_only ERR

health_json() {
  local path="$1"
  curl --fail --silent --show-error --max-time 15 "${API_ORIGIN}${path}"
}

echo '[release] qualify frontend/backend source before touching production data'
( cd "$CLIENT_DIR" && pnpm install --frozen-lockfile && env -u E2E_FRONTEND_URL -u E2E_API_URL -u E2E_TEST_TOKEN -u E2E_TEST_EMAIL_DOMAIN -u E2E_TEST_PASSWORD -u E2E_ACCESS_TOKEN_TTL_SECONDS -u E2E_ADMIN_EMAIL -u E2E_ADMIN_PASSWORD -u E2E_ADMIN_EXPECTED_PATH -u E2E_STAFF_EMAIL -u E2E_STAFF_TEMP_PASSWORD -u E2E_STAFF_NEW_PASSWORD pnpm run release:check )
( cd "$ROOT" && pnpm install --frozen-lockfile && pnpm prisma validate && env -u E2E_FRONTEND_URL -u E2E_API_URL -u E2E_TEST_TOKEN -u E2E_TEST_EMAIL_DOMAIN -u E2E_TEST_PASSWORD -u E2E_ACCESS_TOKEN_TTL_SECONDS -u E2E_ADMIN_EMAIL -u E2E_ADMIN_PASSWORD -u E2E_ADMIN_EXPECTED_PATH -u E2E_STAFF_EMAIL -u E2E_STAFF_TEMP_PASSWORD -u E2E_STAFF_NEW_PASSWORD pnpm run release:check )

echo '[release] disposable fresh-database migration/auth regression'
( cd "$ROOT" && FRESH_DB_TEST_DATABASE_URL="$FRESH_DB_TEST_DATABASE_URL" E2E_TEST_TOKEN="$E2E_TEST_TOKEN" pnpm run test:fresh-db-auth )

echo '[release] production-equivalent staging browser regression (fixtures reset first)'
bash -lc "$E2E_FIXTURE_RESET_CMD"
( cd "$CLIENT_DIR" && \
  E2E_FRONTEND_URL="$E2E_FRONTEND_URL" \
  E2E_API_URL="$E2E_API_URL" \
  E2E_TEST_TOKEN="$E2E_TEST_TOKEN" \
  E2E_TEST_EMAIL_DOMAIN="${E2E_TEST_EMAIL_DOMAIN:-e2e.invalid}" \
  E2E_TEST_PASSWORD="${E2E_TEST_PASSWORD:-Smoke!Test123}" \
  E2E_ACCESS_TOKEN_TTL_SECONDS="$E2E_ACCESS_TOKEN_TTL_SECONDS" \
  E2E_ADMIN_EMAIL="$E2E_ADMIN_EMAIL" \
  E2E_ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD" \
  E2E_ADMIN_EXPECTED_PATH="${E2E_ADMIN_EXPECTED_PATH:-/admin/dashboard}" \
  E2E_STAFF_EMAIL="$E2E_STAFF_EMAIL" \
  E2E_STAFF_TEMP_PASSWORD="$E2E_STAFF_TEMP_PASSWORD" \
  E2E_STAFF_NEW_PASSWORD="${E2E_STAFF_NEW_PASSWORD:-Smoke!Changed123}" \
  E2E_BROWSER_BIN="${E2E_BROWSER_BIN:-chromium}" \
  pnpm run test:e2e:smoke )

echo '[release] Phase 7 CRM/Website Studio browser regression'
if ! ( cd "$CLIENT_DIR" && \
  E2E_FRONTEND_URL="$E2E_FRONTEND_URL" \
  E2E_API_URL="$E2E_API_URL" \
  E2E_ADMIN_EMAIL="$E2E_ADMIN_EMAIL" \
  E2E_ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD" \
  E2E_BROWSER_BIN="${E2E_BROWSER_BIN:-chromium}" \
  pnpm run test:e2e:phase7 ); then
  echo '[release] Phase 7 browser regression failed; resetting staging fixture before aborting' >&2
  bash -lc "$E2E_FIXTURE_RESET_CMD" || true
  exit 1
fi
bash -lc "$E2E_FIXTURE_RESET_CMD"

echo '[1/18] create and verify production database backup'
bash -lc "$PRODUCTION_BACKUP_CMD"

echo '[2/18] inspect migration status (read-only)'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:migrate:status )

echo '[3/18] migration preflight (read-only)'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:migrate:preflight )

echo '[4/18] deploy forward Prisma migrations'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm prisma migrate deploy )
MIGRATIONS_APPLIED=1

echo '[5/18] verify schema drift and auth-session hardening'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:auth-session:verify )
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:drift:check )

echo '[6/18] run report-only reconciliation and integrity gate'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run data:audit:report )
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:reconcile )
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run data:audit:ci )

echo '[7/18] deploy backend application'
DEPLOY_STARTED=1
bash -lc "$BACKEND_DEPLOY_CMD"

echo '[8/18] verify /livez'
health_json /livez >/dev/null

echo '[9/18] verify /readyz'
health_json /readyz >/dev/null

echo '[10/18] verify immutable release metadata at /version'
VERSION_JSON="$(health_json /version)"
node -e 'const x=JSON.parse(process.argv[1]); if(!x.version||!x.gitSha||!x.buildDate||x.gitSha==="unknown"||x.buildDate==="unknown") process.exit(1);' "$VERSION_JSON"

echo '[11/18] direct backend login/session/refresh/logout smoke'
( cd "$ROOT" && AUTH_SMOKE_API_URL="${API_ORIGIN}/api/v1" AUTH_SMOKE_ORIGIN="$FRONTEND_ORIGIN" AUTH_SMOKE_EMAIL="$AUTH_SMOKE_EMAIL" AUTH_SMOKE_PASSWORD="$AUTH_SMOKE_PASSWORD" pnpm run smoke:auth )

echo '[12/18] deploy frontend / same-origin BFF'
bash -lc "$FRONTEND_DEPLOY_CMD"

echo '[13/18] same-origin /backend-api login smoke'
echo '[14/18] canonical /auth/session smoke'
echo '[15/18] refresh rotation smoke'
echo '[16/18] onboarding route/contract smoke'
( cd "$ROOT" && FRONTEND_SMOKE_URL="$FRONTEND_ORIGIN" AUTH_SMOKE_EMAIL="$AUTH_SMOKE_EMAIL" AUTH_SMOKE_PASSWORD="$AUTH_SMOKE_PASSWORD" pnpm run smoke:same-origin-auth )

echo '[17/18] monitor 401/403/5xx/login/refresh reliability signals'
( cd "$ROOT" && API_URL="$API_ORIGIN" PERFORMANCE_METRICS_TOKEN="$PERFORMANCE_METRICS_TOKEN" pnpm run monitoring:alerts )

echo '[18/18] verify outbox/cache/notification/publish/GA operational health'
( cd "$ROOT" && API_URL="$API_ORIGIN" PERFORMANCE_METRICS_TOKEN="$PERFORMANCE_METRICS_TOKEN" pnpm run monitoring:operations )

echo '[release] production rollout gates passed'
if [[ "$MIGRATIONS_APPLIED" == "1" ]]; then
  echo '[release] migrations were applied forward-only; future rollback must keep schema compatibility'
fi
