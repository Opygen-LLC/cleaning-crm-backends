#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT:?}" "${GCP_REGION:?}" "${MIG_NAME:?}" "${NEW_TEMPLATE:?}" "${PREVIOUS_TEMPLATE:?}" "${RELEASE_SHA:?}" "${PREVIOUS_RELEASE_SHA:?}" "${CLOUD_SQL_INSTANCE:?}" "${CLOUD_SQL_MAX_CONNECTIONS:?}"
: "${CANARY_SMOKE_CMD:?Set CANARY_SMOKE_CMD to target the new release directly}"
: "${CANARY_MONITOR_CMD:?Set CANARY_MONITOR_CMD to verify canary health/alerts directly}"
WINDOW_MINUTES="${WINDOW_MINUTES:-10}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

rollback(){
  echo "[canary] rollback -> $PREVIOUS_TEMPLATE"
  gcloud compute instance-groups managed rolling-action start-update "$MIG_NAME" \
    --project="$GCP_PROJECT" --region="$GCP_REGION" \
    --version="template=$PREVIOUS_TEMPLATE" --max-surge=1 --max-unavailable=0
}
trap 'rollback' ERR

gate(){
  local pct="$1" out base since
  echo "[canary] ${pct}% browser smoke"
  bash -lc "$CANARY_SMOKE_CMD"
  echo "[canary] ${pct}% direct monitoring health"
  bash -lc "$CANARY_MONITOR_CMD"

  out="$(mktemp)"; base="$(mktemp)"; since="$(date -u -d "-$WINDOW_MINUTES minutes" +%Y-%m-%dT%H:%M:%SZ)"
  gcloud logging read "jsonPayload.releaseSha=\"$RELEASE_SHA\" AND timestamp>=\"$since\"" \
    --project="$GCP_PROJECT" --format=json --limit=10000 > "$out"
  gcloud logging read "jsonPayload.releaseSha=\"$PREVIOUS_RELEASE_SHA\" AND timestamp>=\"$since\"" \
    --project="$GCP_PROJECT" --format=json --limit=10000 > "$base"
  node "$ROOT/scripts/phase7/evaluateReleaseGate.mjs" "$out" "$base"
  WINDOW_MINUTES="$WINDOW_MINUTES" node "$ROOT/scripts/phase7/checkCloudSqlSaturation.mjs"
  rm -f "$out" "$base"
  echo "[canary] ${pct}% gate passed"
}

wait_and_gate(){
  local pct="$1"
  sleep "${CANARY_WAIT_SECONDS:-180}"
  gate "$pct"
}

echo "[canary] 5%"
gcloud compute instance-groups managed rolling-action start-update "$MIG_NAME" \
  --project="$GCP_PROJECT" --region="$GCP_REGION" \
  --version="template=$PREVIOUS_TEMPLATE" \
  --canary-version="template=$NEW_TEMPLATE,target-size=5%" \
  --max-surge=1 --max-unavailable=0
wait_and_gate 5

echo "[canary] 25%"
gcloud compute instance-groups managed rolling-action start-update "$MIG_NAME" \
  --project="$GCP_PROJECT" --region="$GCP_REGION" \
  --version="template=$PREVIOUS_TEMPLATE" \
  --canary-version="template=$NEW_TEMPLATE,target-size=25%" \
  --max-surge=1 --max-unavailable=0
wait_and_gate 25

echo "[canary] promote 100%"
gcloud compute instance-groups managed rolling-action start-update "$MIG_NAME" \
  --project="$GCP_PROJECT" --region="$GCP_REGION" \
  --version="template=$NEW_TEMPLATE" --max-surge=1 --max-unavailable=0
wait_and_gate 100
trap - ERR
