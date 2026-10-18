#!/usr/bin/env bash
# Print the listener URL and a QR code for it.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ] && [ ! -f backend/data/settings.json ] && [ -z "${EVERY_EAR_DATA_DIR:-}" ]; then
  echo "No .env and no backend/data/settings.json — run an install script first." >&2
  exit 1
fi

exec node scripts/show-url.mjs
