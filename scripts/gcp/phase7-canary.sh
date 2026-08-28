#!/usr/bin/env bash
set -euo pipefail
: "${GCP_PROJECT:?}" "${GCP_REGION:?}" "${MIG_NAME:?}" "${NEW_TEMPLATE:?}" "${PREVIOUS_TEMPLATE:?}" "${RELEASE_SHA:?}" "${PREVIOUS_RELEASE_SHA:?}" "${CLOUD_SQL_INSTANCE:?}" "${CLOUD_SQL_MAX_CONNECTIONS:?}"
WINDOW_MINUTES="${WINDOW_MINUTES:-10}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
rollback(){ echo "[phase7] rollback -> $PREVIOUS_TEMPLATE"; gcloud compute instance-groups managed rolling-action start-update "$MIG_NAME" --project="$GCP_PROJECT" --region="$GCP_REGION" --version="template=$PREVIOUS_TEMPLATE" --max-surge=1 --max-unavailable=0; }
trap 'rollback' ERR

gate(){
  local pct="$1" out base since
  out="$(mktemp)"; base="$(mktemp)"; since="$(date -u -d "-$WINDOW_MINUTES minutes" +%Y-%m-%dT%H:%M:%SZ)"
  gcloud logging read "jsonPayload.releaseSha=\"$RELEASE_SHA\" AND timestamp>=\"$since\"" --project="$GCP_PROJECT" --format=json --limit=10000 > "$out"
  gcloud logging read "jsonPayload.releaseSha=\"$PREVIOUS_RELEASE_SHA\" AND timestamp>=\"$since\"" --project="$GCP_PROJECT" --format=json --limit=10000 > "$base"
  node "$ROOT/scripts/phase7/evaluateReleaseGate.mjs" "$out" "$base"
  WINDOW_MINUTES="$WINDOW_MINUTES" node "$ROOT/scripts/phase7/checkCloudSqlSaturation.mjs"
  rm -f "$out" "$base"
  echo "[phase7] ${pct}% gate passed"
}

echo "[phase7] canary 5%"
gcloud compute instance-groups managed rolling-action start-update "$MIG_NAME" --project="$GCP_PROJECT" --region="$GCP_REGION" --version="template=$PREVIOUS_TEMPLATE" --canary-version="template=$NEW_TEMPLATE,target-size=5%" --max-surge=1 --max-unavailable=0
sleep "${CANARY_WAIT_SECONDS:-180}"
gate 5

echo "[phase7] canary 25%"
gcloud compute instance-groups managed rolling-action start-update "$MIG_NAME" --project="$GCP_PROJECT" --region="$GCP_REGION" --version="template=$PREVIOUS_TEMPLATE" --canary-version="template=$NEW_TEMPLATE,target-size=25%" --max-surge=1 --max-unavailable=0
sleep "${CANARY_WAIT_SECONDS:-180}"
gate 25

echo "[phase7] promote 100%"
gcloud compute instance-groups managed rolling-action start-update "$MIG_NAME" --project="$GCP_PROJECT" --region="$GCP_REGION" --version="template=$NEW_TEMPLATE" --max-surge=1 --max-unavailable=0
trap - ERR
