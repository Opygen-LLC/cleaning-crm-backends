#!/usr/bin/env bash
set -euo pipefail

SECRET_NAME="${GCP_BACKEND_ENV_SECRET:-cleaning-crm-backend-env}"
OUTPUT_FILE="${1:-.env.runtime}"
TMP_FILE="${OUTPUT_FILE}.tmp"

command -v gcloud >/dev/null 2>&1 || { echo "gcloud CLI is required" >&2; exit 1; }

umask 077
gcloud secrets versions access latest --secret="$SECRET_NAME" > "$TMP_FILE"

if ! grep -q '^DATABASE_URL=' "$TMP_FILE"; then
  rm -f "$TMP_FILE"
  echo "Secret payload is missing DATABASE_URL" >&2
  exit 1
fi
if ! grep -q '^BETTER_AUTH_SECRET=' "$TMP_FILE"; then
  rm -f "$TMP_FILE"
  echo "Secret payload is missing BETTER_AUTH_SECRET" >&2
  exit 1
fi

mv "$TMP_FILE" "$OUTPUT_FILE"
chmod 600 "$OUTPUT_FILE"
echo "Loaded Google Secret Manager secret '$SECRET_NAME' into $OUTPUT_FILE"
