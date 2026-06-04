#!/usr/bin/env bash
# Start LiveKit + backend + frontend + Caddy. Keeps the Mac awake.
# Uses overmind if it's installed (best ergonomics); otherwise falls
# back to the cross-platform Node orchestrator.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env — run scripts/install-mac.sh first." >&2
  exit 1
fi

if command -v overmind >/dev/null 2>&1; then
  # Caddy needs to bind to 443. On macOS, ports <1024 require sudo unless we
  # delegate that capability. overmind doesn't support per-process sudo, so
  # we elevate the whole tree once and use caffeinate to keep the system awake.
  echo "Starting Every Ear via overmind. Sudo is needed once so Caddy can bind to :443."
  exec sudo -E caffeinate -dimsu overmind start --procfile Procfile
else
  echo "overmind not installed — starting via the cross-platform orchestrator."
  echo "Sudo is needed once so Caddy can bind to :443."
  exec sudo -E caffeinate -dimsu node scripts/dev.mjs
fi
