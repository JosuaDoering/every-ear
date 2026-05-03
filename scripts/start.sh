#!/usr/bin/env bash
# Start LiveKit + backend + frontend + Caddy. Keeps the Mac awake.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env — run scripts/install-mac.sh first." >&2
  exit 1
fi

if ! command -v overmind >/dev/null 2>&1; then
  echo "overmind not found — run scripts/install-mac.sh first." >&2
  exit 1
fi

# Caddy needs to bind to 443. On macOS, ports <1024 require sudo unless we
# delegate that capability. Easiest: prefix with sudo when starting Caddy.
# overmind doesn't support per-process sudo cleanly, so instead we prompt once
# here and use sudo to keep the system awake AND own the whole tree.
echo "Starting LocalLingua. Sudo is needed once so Caddy can bind to :443."

exec sudo -E caffeinate -dimsu overmind start --procfile Procfile
