#!/usr/bin/env bash
# Every Ear health/diagnostic check. Run on the server:
#     ./scripts/doctor.sh
# Exits non-zero if something looks wrong, so it can be used from monitoring.
set -uo pipefail

CONFIG_DIR="${CONFIG_DIR:-/etc/every-ear}"
DATA_DIR="${DATA_DIR:-/var/lib/every-ear}"
LISTENER_PORT="${LISTENER_PORT:-8443}"
BACKEND_PORT="${BACKEND_PORT:-3000}"

[ -f "$CONFIG_DIR/env" ] && { set -a; . "$CONFIG_DIR/env"; set +a; }
LISTENER_PORT="${LISTENER_PORT}"
HOST="${DOMAIN:-${PUBLIC_HOST:-localhost}}"

FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

echo "Every Ear doctor"
echo "================"

echo "Services:"
for u in every-ear-livekit every-ear-backend every-ear-caddy; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then ok "$u is running"; else bad "$u is NOT running"; fi
done

echo "Ports (listening):"
if command -v ss >/dev/null 2>&1; then
  for spec in "${LISTENER_PORT}:tcp:listener HTTPS" "7880:tcp:LiveKit signaling" "7881:tcp:LiveKit TCP fallback" "7882:udp:LiveKit media"; do
    port="${spec%%:*}"; rest="${spec#*:}"; proto="${rest%%:*}"; label="${rest#*:}"
    if ss -lntu 2>/dev/null | grep -qE "[:.]${port}[[:space:]]"; then
      ok "$port/$proto ($label)"
    else
      # UDP sockets may not show the same way; be lenient for udp.
      if [ "$proto" = "udp" ]; then warn "$port/$proto ($label) not seen — check firewall"; else bad "$port/$proto ($label) not listening"; fi
    fi
  done
else
  warn "ss (iproute2) not found — skipping port checks (apt-get install -y iproute2)"
fi

echo "Backend health:"
HEALTH="$(curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/health" 2>/dev/null || true)"
if [ -z "$HEALTH" ]; then
  bad "no response from http://127.0.0.1:${BACKEND_PORT}/api/health"
else
  ok "$HEALTH"
  echo "$HEALTH" | grep -q '"livekit":"ok"' && ok "LiveKit reachable" || bad "LiveKit unreachable from backend"
  echo "$HEALTH" | grep -q '"dataWritable":true' && ok "data dir writable" || bad "data dir NOT writable"
fi

echo "HTTPS endpoint:"
if curl -fsSk --max-time 5 "https://127.0.0.1:${LISTENER_PORT}/api/health" >/dev/null 2>&1; then
  ok "https://${HOST}:${LISTENER_PORT}/ responds"
else
  bad "https://${HOST}:${LISTENER_PORT}/ did not respond"
fi

echo "Kernel tuning:"
for kv in net.core.rmem_max=16777216 net.core.wmem_max=16777216 net.core.netdev_max_backlog=5000; do
  key="${kv%%=*}"; want="${kv##*=}"; got="$(sysctl -n "$key" 2>/dev/null || echo '?')"
  [ "$got" = "$want" ] && ok "$key=$got" || warn "$key=$got (expected $want) — run sysctl --system"
done

echo "Disk:"
FREE_PCT="$(df -P "$DATA_DIR" 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%')"
if [ -n "${FREE_PCT:-}" ]; then
  if [ "$FREE_PCT" -lt 90 ]; then ok "data filesystem ${FREE_PCT}% used"; else bad "data filesystem ${FREE_PCT}% used"; fi
else
  warn "could not determine disk usage for $DATA_DIR"
fi

echo "Recent LiveKit warnings (UDP buffers etc.):"
journalctl -u every-ear-livekit --since "1 hour ago" --no-pager 2>/dev/null \
  | grep -iE "buffer|too small|error" | tail -n 5 | sed 's/^/  /' || true

echo
if [ "$FAIL" -eq 0 ]; then echo "All checks passed."; else echo "Some checks failed (see above)."; fi
exit "$FAIL"
