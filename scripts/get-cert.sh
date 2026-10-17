#!/usr/bin/env bash
# Obtain (and auto-renew) a trusted Let's Encrypt certificate via DNS-01 using
# netcup's new REST API. This is the scripted alternative to the web admin's
# "Get certificate (Netcup)" button.
#
# Required env:
#   DOMAIN           e.g. events.example.com
#   NETCUP_API_KEY   the 64-character netcup REST API key
# Optional:
#   ACME_EMAIL (account contact), TLS_DIR (default /etc/every-ear/tls),
#   DATA_DIR (default /var/lib/every-ear)
#
# DNS-01 needs no inbound port. The A record must point the domain at this host
# and has to be set manually in the netcup CCP (the REST API cannot manage A
# records).
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=events.example.com}"
NETCUP_API_KEY="${NETCUP_API_KEY:?set NETCUP_API_KEY to your 64-character netcup REST API key}"
TLS_DIR="${TLS_DIR:-/etc/every-ear/tls}"
DATA_DIR="${DATA_DIR:-/var/lib/every-ear}"
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
ACME_EMAIL="${ACME_EMAIL:-admin@$DOMAIN}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v python3 >/dev/null 2>&1 || { echo "python3 is required (apt-get install -y python3)." >&2; exit 1; }
if [ "${#NETCUP_API_KEY}" -ne 64 ]; then
  echo "Warning: the new netcup REST API key is 64 characters; yours is ${#NETCUP_API_KEY}." >&2
fi

if [ ! -x "$ACME_HOME/acme.sh" ] && [ ! -x "$HOME/.acme.sh/acme.sh" ]; then
  echo "→ Installing acme.sh…"
  curl -fsSL https://get.acme.sh | sh -s email="$ACME_EMAIL"
fi
if [ -x "$ACME_HOME/acme.sh" ]; then
  ACME="$ACME_HOME/acme.sh"
else
  ACME="$HOME/.acme.sh/acme.sh"
fi

echo "→ Installing netcup REST API hook…"
mkdir -p "$ACME_HOME/dnsapi"
install -m 0644 "$SCRIPT_DIR/../deploy/acme/dns_netcup.sh" "$ACME_HOME/dnsapi/dns_netcup.sh"

export NETCUP_API_KEY

echo "→ Requesting certificate for $DOMAIN (Let's Encrypt, DNS-01)…"
"$ACME" --issue --server letsencrypt --dns dns_netcup -d "$DOMAIN" --keylength ec-256

mkdir -p "$TLS_DIR"
echo "→ Installing certificate into $TLS_DIR…"
"$ACME" --install-cert --server letsencrypt -d "$DOMAIN" --ecc \
  --fullchain-file "$TLS_DIR/fullchain.pem" \
  --key-file "$TLS_DIR/privkey.pem" \
  --reloadcmd "systemctl reload every-ear-caddy 2>/dev/null || true"

chmod 0644 "$TLS_DIR/fullchain.pem"
chmod 0600 "$TLS_DIR/privkey.pem"

# Point the backend's settings at these files so its generated Caddyfile uses
# the certificate (and keeps using it across renewals).
if [ -f "$DATA_DIR/settings.json" ]; then
  python3 - "$DATA_DIR/settings.json" "$DOMAIN" "$TLS_DIR/fullchain.pem" "$TLS_DIR/privkey.pem" <<'PY'
import json, sys
path, domain, cert, key = sys.argv[1:5]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
data["customDomain"] = domain
data["customCertFile"] = cert
data["customKeyFile"] = key
data.pop("netcupCustomerId", None)
data.pop("netcupApiPassword", None)
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
PY
  chown every-ear:every-ear "$DATA_DIR/settings.json" 2>/dev/null || true
  chmod 0600 "$DATA_DIR/settings.json"
  # Restart the backend so it regenerates the Caddyfile and reloads Caddy.
  systemctl restart every-ear-backend 2>/dev/null || true
fi

echo "✓ Certificate installed. acme.sh renews it automatically (cron) and reloads Caddy."
echo "  The DNS A record must be set manually in the netcup CCP (the REST API cannot manage it)."
