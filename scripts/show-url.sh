#!/usr/bin/env bash
# Print the listener URL and a QR code for it.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env — run scripts/install-mac.sh first." >&2
  exit 1
fi

exec node scripts/show-url.mjs
