#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="${CLIENT_DIR:?Set CLIENT_DIR to the Phase 4 frontend checkout}"
: "${PRODUCTION_DATABASE_URL:?Set PRODUCTION_DATABASE_URL}"
: "${PRODUCTION_BACKUP_CMD:?Set PRODUCTION_BACKUP_CMD to a verified database backup/snapshot command}"
: "${BACKEND_DEPLOY_CMD:?Set BACKEND_DEPLOY_CMD}"
: "${FRONTEND_DEPLOY_CMD:?Set FRONTEND_DEPLOY_CMD}"
: "${APPLICATION_ROLLBACK_CMD:?Set APPLICATION_ROLLBACK_CMD for app rollback only}"
: "${E2E_FRONTEND_URL:?Set E2E_FRONTEND_URL to production-equivalent staging before this release}"
: "${E2E_ADMIN_EMAIL:?Set E2E_ADMIN_EMAIL}"
: "${E2E_ADMIN_PASSWORD:?Set E2E_ADMIN_PASSWORD}"
: "${PHASE4_RELEASE_ACK:?Set PHASE4_RELEASE_ACK=apply-phase4-cleaning-crm}"

if [[ "$PHASE4_RELEASE_ACK" != "apply-phase4-cleaning-crm" ]]; then
  echo "Refusing release: PHASE4_RELEASE_ACK must equal apply-phase4-cleaning-crm" >&2
  exit 2
fi

DEPLOY_STARTED=0
rollback_application_only() {
  local code=$?
  if [[ "$DEPLOY_STARTED" == "1" ]]; then
    echo "[phase4] release failed after application deployment began; rolling back applications only" >&2
    echo "[phase4] Prisma migrations/backfills are forward-only and are not automatically reversed" >&2
    bash -lc "$APPLICATION_ROLLBACK_CMD" || true
  fi
  exit "$code"
}
trap rollback_application_only ERR

printf '%s\n' '[phase4 0/10] qualify both source trees before production mutation'
( cd "$ROOT" && pnpm install --frozen-lockfile && pnpm run release:phase4:cleaning-crm )
( cd "$CLIENT_DIR" && pnpm install --frozen-lockfile && pnpm run release:phase4:cleaning-crm )

printf '%s\n' '[phase4 1/10] create verified database backup/snapshot'
bash -lc "$PRODUCTION_BACKUP_CMD"

printf '%s\n' '[phase4 2/10] inspect migration state and dry-run backfills'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:migrate:status )
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run phase4:backfill:report )

printf '%s\n' '[phase4 3/10] apply forward-only Prisma migrations (never db push)'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:migrate:deploy )

printf '%s\n' '[phase4 4/10] deploy backward-compatible backend first'
DEPLOY_STARTED=1
bash -lc "$BACKEND_DEPLOY_CMD"

printf '%s\n' '[phase4 5/10] run idempotent country and online-booking reconciliation'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run phase4:backfill:fix )

printf '%s\n' '[phase4 6/10] verify migrations and zero critical backfill failures'
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run db:migrate:status )
( cd "$ROOT" && DATABASE_URL="$PRODUCTION_DATABASE_URL" pnpm run phase4:backfill:verify )

printf '%s\n' '[phase4 7/10] production-equivalent browser/API smoke before frontend activation'
( cd "$CLIENT_DIR" && \
  E2E_FRONTEND_URL="$E2E_FRONTEND_URL" \
  E2E_ADMIN_EMAIL="$E2E_ADMIN_EMAIL" \
  E2E_ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD" \
  E2E_BROWSER_BIN="${E2E_BROWSER_BIN:-chromium}" \
  E2E_DRAFT_QUOTE_ID="${E2E_DRAFT_QUOTE_ID:-}" \
  E2E_FOREIGN_LEAD_ID="${E2E_FOREIGN_LEAD_ID:-}" \
  pnpm run test:e2e:phase4:cleaning-crm )

printf '%s\n' '[phase4 8/10] deploy frontend'
bash -lc "$FRONTEND_DEPLOY_CMD"

printf '%s\n' '[phase4 9/10] repeat exact Phase 4 browser/API smoke after frontend deployment'
( cd "$CLIENT_DIR" && \
  E2E_FRONTEND_URL="$E2E_FRONTEND_URL" \
  E2E_ADMIN_EMAIL="$E2E_ADMIN_EMAIL" \
  E2E_ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD" \
  E2E_BROWSER_BIN="${E2E_BROWSER_BIN:-chromium}" \
  E2E_DRAFT_QUOTE_ID="${E2E_DRAFT_QUOTE_ID:-}" \
  E2E_FOREIGN_LEAD_ID="${E2E_FOREIGN_LEAD_ID:-}" \
  pnpm run test:e2e:phase4:cleaning-crm )

printf '%s\n' '[phase4 10/10] run optional observation/health command'
if [[ -n "${PRODUCTION_OBSERVE_CMD:-}" ]]; then
  bash -lc "$PRODUCTION_OBSERVE_CMD"
fi

echo '[phase4] release gates passed; keep schema/data forward-compatible if application rollback is needed'
