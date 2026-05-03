#!/usr/bin/env bash
# Print the listener URL and a QR code for it.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env — run scripts/install-mac.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

URL="https://${PUBLIC_HOST}/"
TRANSLATOR_URL="https://${PUBLIC_HOST}/translator.html"

echo
echo "Listener URL:   ${URL}"
echo "Translator URL: ${TRANSLATOR_URL}"
echo

if command -v qrencode >/dev/null 2>&1; then
  echo "Listener QR:"
  qrencode -t ANSIUTF8 "${URL}"
else
  echo "(install qrencode for an inline QR code: brew install qrencode)"
fi
