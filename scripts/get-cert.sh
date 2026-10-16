#!/usr/bin/env bash
# Obtain (and auto-renew) a trusted Let's Encrypt certificate via DNS-01, so
# listener devices never see a certificate warning. Uses acme.sh + the Netcup
# DNS API hook shipped in deploy/acme/.
#
# Required env:
#   DOMAIN                    e.g. events.example.com
#   NETCUP_CUSTOMER_ID, NETCUP_API_KEY, NETCUP_API_PASSWORD
# Optional:
#   ACME_EMAIL (account contact), TLS_DIR (default /etc/every-ear/tls)
#
# The domain's A record must already point at this host's LAN IP (set it in the
# Netcup control panel, or via the app's DNS screen). DNS-01 needs no inbound
# port, so this works entirely offline from the event network's perspective.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=events.example.com}"
TLS_DIR="${TLS_DIR:-/etc/every-ear/tls}"
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
ACME_EMAIL="${ACME_EMAIL:-admin@$DOMAIN}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v python3 >/dev/null 2>&1 || { echo "python3 is required for the Netcup hook (apt-get install -y python3)." >&2; exit 1; }
for v in NETCUP_CUSTOMER_ID NETCUP_API_KEY NETCUP_API_PASSWORD; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "$v is required." >&2; exit 1; }
done

if [ ! -x "$ACME_HOME/acme.sh" ] && [ ! -x "$HOME/.acme.sh/acme.sh" ]; then
  echo "→ Installing acme.sh…"
  curl -fsSL https://get.acme.sh | sh -s email="$ACME_EMAIL"
fi
if [ -x "$ACME_HOME/acme.sh" ]; then
  ACME="$ACME_HOME/acme.sh"
else
  ACME="$HOME/.acme.sh/acme.sh"
fi

echo "→ Installing Netcup DNS hook…"
mkdir -p "$ACME_HOME/dnsapi"
install -m 0644 "$SCRIPT_DIR/../deploy/acme/dns_netcup.sh" "$ACME_HOME/dnsapi/dns_netcup.sh"

export NETCUP_CUSTOMER_ID NETCUP_API_KEY NETCUP_API_PASSWORD

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

if id every-ear >/dev/null 2>&1; then
  chown -R every-ear:every-ear "$TLS_DIR"
fi

echo "✓ Certificate installed. acme.sh renews it automatically (cron) and reloads Caddy."
echo "  Re-run scripts/install-debian.sh (or set DOMAIN in the env file) to point Caddy at it."
