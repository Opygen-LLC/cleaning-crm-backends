#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${FRESH_DB_TEST_DATABASE_URL:?Set FRESH_DB_TEST_DATABASE_URL to a disposable EMPTY PostgreSQL database}"
: "${E2E_TEST_TOKEN:?Set E2E_TEST_TOKEN (32+ chars)}"
PORT="${FRESH_DB_TEST_PORT:-5099}"
LOG_FILE="${TMPDIR:-/tmp}/cleaning-crm-fresh-db-${PORT}.log"
API_PID=""
cleanup() { if [[ -n "$API_PID" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi; }
trap cleanup EXIT
cd "$ROOT"
export DATABASE_URL="$FRESH_DB_TEST_DATABASE_URL"

echo '[fresh-db] applying forward migrations to disposable database'
pnpm prisma migrate deploy

echo '[fresh-db] verifying Phase 1 schema contract after migrations'
pnpm run db:phase1:verify

echo '[fresh-db] generating Prisma client and building server'
pnpm prisma generate
pnpm run build:docker

echo '[fresh-db] starting test API with staging-only OTP hook'
NODE_ENV=test PROCESS_ROLE=api BACKEND_IP=127.0.0.1 PORT="$PORT" \
E2E_TEST_HOOKS_ENABLED=true E2E_TEST_TOKEN="$E2E_TEST_TOKEN" \
BETTER_AUTH_URL="http://127.0.0.1:${PORT}" APP_URL="http://127.0.0.1:3000" FRONTEND_URL="http://127.0.0.1:3000" \
AUTH_ALLOWED_ORIGINS="http://127.0.0.1:3000" \
ACCESS_TOKEN_SECRET="${ACCESS_TOKEN_SECRET:-fresh-db-access-secret-01234567890123456789}" \
REFRESH_TOKEN_SECRET="${REFRESH_TOKEN_SECRET:-fresh-db-refresh-secret-012345678901234567}" \
BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-fresh-db-better-auth-secret-0123456789012345}" \
ACCESS_TOKEN_EXPIRES_IN=15m REFRESH_TOKEN_EXPIRES_IN=30d \
node dist/index.js >"$LOG_FILE" 2>&1 &
API_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/livez" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then cat "$LOG_FILE"; exit 1; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:${PORT}/livez" >/dev/null || { cat "$LOG_FILE"; exit 1; }
FRESH_DB_API_URL="http://127.0.0.1:${PORT}/api/v1" node scripts/release/freshDatabaseAuthSmoke.mjs
