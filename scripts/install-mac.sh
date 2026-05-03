#!/usr/bin/env bash
# Run once on a fresh MacBook to install everything LocalLingua needs.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install from https://brew.sh first." >&2
  exit 1
fi

echo "→ Installing Homebrew packages…"
brew install livekit livekit-cli node@22 caddy overmind qrencode

if [ ! -f .env ]; then
  cp .env.example .env
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '127.0.0.1')"
  /usr/bin/sed -i '' "s/^LIVEKIT_NODE_IP=.*/LIVEKIT_NODE_IP=${LAN_IP}/" .env
  /usr/bin/sed -i '' "s/^PUBLIC_HOST=.*/PUBLIC_HOST=${LAN_IP}/" .env
  echo "→ Wrote .env (LAN IP detected: ${LAN_IP}). Edit passwords before going live."
fi

echo "→ Installing backend dependencies…"
(cd backend && npm install)

echo "→ Installing frontend dependencies…"
(cd frontend && npm install)

echo "→ Allowing Caddy to bind 443 without sudo (one-time)…"
sudo /usr/sbin/setfile -a v "$(brew --prefix)/bin/caddy" 2>/dev/null || true

cat <<'EOF'

✓ Setup done.

Next steps:
  1. Edit .env — set strong passwords for each TRANSLATOR_PASSWORD_*.
  2. Start everything:    ./scripts/start.sh
  3. Show listener URL:   ./scripts/show-url.sh

The first time you start, macOS will ask whether to allow incoming
connections for livekit-server and caddy. Click "Allow" both times.
EOF
