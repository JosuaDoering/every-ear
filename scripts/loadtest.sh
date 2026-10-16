#!/usr/bin/env bash
# Load-test a LiveKit room with N subscribers, to validate a node before a big
# event. Requires `livekit-cli` on PATH and the stack running.
#
#   ./scripts/loadtest.sh "event-<id>-lang-en" 600 60s
#
# Args: <room> [subscribers] [duration]
set -euo pipefail

ROOM="${1:?usage: loadtest.sh <room> [subscribers] [duration]}"
SUBS="${2:-200}"
DURATION="${3:-60s}"

CONFIG_DIR="${CONFIG_DIR:-/etc/every-ear}"
ENV_FILE="${EVERY_EAR_ENV:-$CONFIG_DIR/env}"
# Fall back to a repo .env when run from a checkout.
[ -f "$ENV_FILE" ] || ENV_FILE="$(dirname "$0")/../.env"
[ -f "$ENV_FILE" ] || { echo "No env file found ($ENV_FILE)." >&2; exit 1; }

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

: "${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY}"
: "${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET}"
URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"

echo "→ Load-testing room '$ROOM' with $SUBS subscribers for $DURATION (url=$URL)"
livekit-cli load-test \
  --url "$URL" \
  --api-key "$LIVEKIT_API_KEY" \
  --api-secret "$LIVEKIT_API_SECRET" \
  --room "$ROOM" \
  --subscribers "$SUBS" \
  --duration "$DURATION"

echo "✓ Load test finished. Watch 'every-ear-backend' stats and node CPU/uplink during the run."
