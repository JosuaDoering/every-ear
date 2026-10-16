#!/usr/bin/env bash
# Every Ear — Debian server installer.
#
# Sets up a headless, self-contained deployment:
#   - systemd units for livekit-server, the Fastify backend and Caddy
#   - kernel/network tuning (sysctl), log rotation
#   - a dedicated `every-ear` system user; no root at runtime
#   - optional trusted HTTPS via a DNS-01 certificate (so listener devices
#     never see a certificate warning)
#
# Run from the repository checkout as root:
#     sudo ./scripts/install-debian.sh
#
# Configuration is read from .env (created from .env.example if missing). Useful
# environment overrides before running:
#     LISTENER_PORT=8443   BACKEND_PORT=3000
#     DOMAIN=events.example.com        # enables trusted HTTPS
#     NETCUP_CUSTOMER_ID / NETCUP_API_KEY / NETCUP_API_PASSWORD   # ACME DNS-01
set -euo pipefail

# ---- paths -----------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/every-ear}"
CONFIG_DIR="${CONFIG_DIR:-/etc/every-ear}"
DATA_DIR="${DATA_DIR:-/var/lib/every-ear}"
LOG_DIR="${LOG_DIR:-/var/log/every-ear}"
TLS_DIR="${TLS_DIR:-/etc/every-ear/tls}"
SERVICE_USER="${SERVICE_USER:-every-ear}"

LISTENER_PORT="${LISTENER_PORT:-8443}"
BACKEND_PORT="${BACKEND_PORT:-3000}"

LIVEKIT_VERSION="${LIVEKIT_VERSION:-v1.11.0}"
CADDY_VERSION="${CADDY_VERSION:-v2.8.4}"

ENV_SRC="$REPO_DIR/.env"

log()  { printf '\033[36m→\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root: sudo $0"
[ -f "$REPO_DIR/livekit.yaml" ] || die "Run this from the repository checkout (livekit.yaml not found)."

# ---- prerequisites ---------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 20+ (e.g. NodeSource) first."
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ required (found $("$NODE_BIN" -v))."
command -v npm  >/dev/null 2>&1 || die "npm not found."
command -v curl >/dev/null 2>&1 || die "curl not found (apt-get install -y curl)."
command -v tar  >/dev/null 2>&1 || die "tar not found."

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) LK_ARCH=amd64; CADDY_ARCH=amd64 ;;
  aarch64|arm64) LK_ARCH=arm64; CADDY_ARCH=arm64 ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

# ---- .env ------------------------------------------------------------------
if [ ! -f "$ENV_SRC" ]; then
  log "No .env found — creating one from .env.example"
  cp "$REPO_DIR/.env.example" "$ENV_SRC"
fi

# shellcheck disable=SC1090
set -a; . "$ENV_SRC"; set +a

# Fill in anything essential that is missing / still the example default.
DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${DETECTED_IP:-}" ] || DETECTED_IP="127.0.0.1"
DOMAIN="${DOMAIN:-}"

# The .env.example placeholders must not win over the server's real address.
is_placeholder_host() { [ -z "${1:-}" ] || [ "$1" = "192.168.1.10" ] || [ "$1" = "192.168.1.119" ]; }

if [ -z "${LIVEKIT_API_KEY:-}" ] || [ "$LIVEKIT_API_KEY" = "devkey" ]; then
  LIVEKIT_API_KEY="lk_$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
if [ -z "${LIVEKIT_API_SECRET:-}" ] || [ "$LIVEKIT_API_SECRET" = "please-change-me-to-32-bytes-of-randomness" ]; then
  LIVEKIT_API_SECRET="$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
if [ -z "${ADMIN_PASSWORD:-}" ] || [ "$ADMIN_PASSWORD" = "change-me-admin" ]; then
  ADMIN_PASSWORD="$(head -c12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  warn "Generated a new admin password: $ADMIN_PASSWORD"
  warn "Store it now — it is shown only here and in $CONFIG_DIR/env."
fi
[ -n "${LIVEKIT_NODE_IP:-}" ] || LIVEKIT_NODE_IP="$DETECTED_IP"
[ -n "${PUBLIC_HOST:-}" ]   || PUBLIC_HOST="$DETECTED_IP"
is_placeholder_host "$LIVEKIT_NODE_IP" && LIVEKIT_NODE_IP="$DETECTED_IP"
is_placeholder_host "$PUBLIC_HOST"     && PUBLIC_HOST="$DETECTED_IP"

log "Install directory : $INSTALL_DIR"
log "Data directory    : $DATA_DIR"
log "Listener URL      : https://${DOMAIN:-$PUBLIC_HOST}:${LISTENER_PORT}/"

# ---- build frontend + backend ---------------------------------------------
log "Installing dependencies and building (this can take a few minutes)…"
( cd "$REPO_DIR/backend"  && npm ci && npm run build )
( cd "$REPO_DIR/frontend" && npm ci && npm run build )

# ---- download native binaries ---------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

LK_TARBALL="livekit_${LIVEKIT_VERSION#v}_linux_${LK_ARCH}.tar.gz"
log "Downloading LiveKit ${LIVEKIT_VERSION} ($LK_ARCH)…"
curl -fL "https://github.com/livekit/livekit/releases/download/${LIVEKIT_VERSION}/${LK_TARBALL}" -o "$TMP/lk.tar.gz"
tar -xzf "$TMP/lk.tar.gz" -C "$TMP"
LK_BIN="$(find "$TMP" -type f -name 'livekit-server' | head -n1)"
[ -n "$LK_BIN" ] || die "Could not find livekit-server in the release archive."

CADDY_TARBALL="caddy_${CADDY_VERSION#v}_linux_${CADDY_ARCH}.tar.gz"
log "Downloading Caddy ${CADDY_VERSION} ($CADDY_ARCH)…"
curl -fL "https://github.com/caddyserver/caddy/releases/download/${CADDY_VERSION}/${CADDY_TARBALL}" -o "$TMP/caddy.tar.gz"
tar -xzf "$TMP/caddy.tar.gz" -C "$TMP"
CADDY_BIN="$(find "$TMP" -type f -name 'caddy' | head -n1)"
[ -n "$CADDY_BIN" ] || die "Could not find caddy in the release archive."

# ---- user + directories ----------------------------------------------------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user $SERVICE_USER"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/backend" "$INSTALL_DIR/frontend" \
         "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR" "$TLS_DIR"

# ---- install files ---------------------------------------------------------
log "Installing application files into $INSTALL_DIR"
install -m 0755 "$LK_BIN"    "$INSTALL_DIR/bin/livekit-server"
install -m 0755 "$CADDY_BIN" "$INSTALL_DIR/bin/caddy"
install -m 0644 "$REPO_DIR/livekit.yaml" "$INSTALL_DIR/livekit.yaml"

rm -rf "$INSTALL_DIR/backend/dist" "$INSTALL_DIR/backend/node_modules"
cp -a "$REPO_DIR/backend/dist"         "$INSTALL_DIR/backend/dist"
cp -a "$REPO_DIR/backend/package.json" "$INSTALL_DIR/backend/package.json"
cp -a "$REPO_DIR/backend/node_modules" "$INSTALL_DIR/backend/node_modules"

rm -rf "$INSTALL_DIR/frontend/dist"
cp -a "$REPO_DIR/frontend/dist" "$INSTALL_DIR/frontend/dist"

# ---- optional trusted certificate (DNS-01) ---------------------------------
# Must run before the Caddyfile is written so the generated config can point at
# the real certificate (otherwise it bakes in `tls internal`).
if [ -n "$DOMAIN" ]; then
  if [ -f "$TLS_DIR/fullchain.pem" ]; then
    log "Trusted certificate already present for $DOMAIN — reusing it."
  elif [ -n "${NETCUP_CUSTOMER_ID:-}" ] && [ -n "${NETCUP_API_KEY:-}" ] && [ -n "${NETCUP_API_PASSWORD:-}" ]; then
    log "Obtaining a trusted certificate for $DOMAIN via Netcup DNS-01…"
    DOMAIN="$DOMAIN" TLS_DIR="$TLS_DIR" SERVICE_USER="$SERVICE_USER" \
      "$REPO_DIR/scripts/get-cert.sh" || warn "Certificate issuance failed — falling back to internal TLS for now."
  else
    warn "DOMAIN=$DOMAIN set but no Netcup credentials and no existing certificate."
    warn "Run scripts/get-cert.sh later, or set NETCUP_* and re-run the installer."
  fi
fi

# ---- Caddyfile -------------------------------------------------------------
if [ -n "$DOMAIN" ] && [ -f "$TLS_DIR/fullchain.pem" ] && [ -f "$TLS_DIR/privkey.pem" ]; then
  TLS_LINE="tls $TLS_DIR/fullchain.pem $TLS_DIR/privkey.pem"
  CADDY_HOST="$DOMAIN"
else
  TLS_LINE="tls internal"
  CADDY_HOST="$PUBLIC_HOST"
fi
log "Writing $INSTALL_DIR/Caddyfile (host=${CADDY_HOST}, tls=${TLS_LINE%% *})"
sed \
  -e "s#__PUBLIC_HOST__#${CADDY_HOST}#g" \
  -e "s#__LISTENER_PORT__#${LISTENER_PORT}#g" \
  -e "s#__BACKEND_PORT__#${BACKEND_PORT}#g" \
  -e "s#__FRONTEND_DIST__#${INSTALL_DIR}/frontend/dist#g" \
  -e "s#__DATA_DIR__#${DATA_DIR}#g" \
  -e "s#__LOG_DIR__#${LOG_DIR}#g" \
  -e "s#__TLS__#${TLS_LINE}#g" \
  "$REPO_DIR/deploy/Caddyfile.tmpl" > "$INSTALL_DIR/Caddyfile"

# ---- environment file ------------------------------------------------------
log "Writing $CONFIG_DIR/env"
{
  echo "# Generated by scripts/install-debian.sh — do not edit livekit secret here by hand."
  echo "LIVEKIT_API_KEY=${LIVEKIT_API_KEY}"
  echo "LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}"
  echo "LIVEKIT_NODE_IP=${LIVEKIT_NODE_IP}"
  echo "PUBLIC_HOST=${PUBLIC_HOST}"
  echo "BACKEND_PORT=${BACKEND_PORT}"
  echo "ADMIN_PASSWORD=${ADMIN_PASSWORD}"
  echo "EVERY_EAR_DATA_DIR=${DATA_DIR}"
  echo "EVERY_EAR_DEFAULT_BG=${INSTALL_DIR}/frontend/dist/bg.jpg"
  echo "LIVEKIT_WEBHOOK_API_KEY=${LIVEKIT_API_KEY}"
  echo "LIVEKIT_WEBHOOK_URLS=http://127.0.0.1:${BACKEND_PORT}/api/livekit/webhook"
  [ -n "${LANGUAGES:-}" ]       && echo "LANGUAGES=${LANGUAGES}"
  [ -n "${LANGUAGE_NAMES:-}" ]  && echo "LANGUAGE_NAMES='${LANGUAGE_NAMES}'"
  [ -n "${LANGUAGE_FLAGS:-}" ]  && echo "LANGUAGE_FLAGS='${LANGUAGE_FLAGS}'"
  [ -n "${OPENROUTER_API_KEY:-}" ] && echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
  [ -n "${OPENROUTER_MODEL:-}" ]   && echo "OPENROUTER_MODEL=${OPENROUTER_MODEL}"
  [ -n "${RATE_LIMIT_GLOBAL_MAX:-}" ]   && echo "RATE_LIMIT_GLOBAL_MAX=${RATE_LIMIT_GLOBAL_MAX}"
  [ -n "${RATE_LIMIT_LISTENER_MAX:-}" ] && echo "RATE_LIMIT_LISTENER_MAX=${RATE_LIMIT_LISTENER_MAX}"
} > "$CONFIG_DIR/env"
chmod 0600 "$CONFIG_DIR/env"

# ---- systemd units ---------------------------------------------------------
log "Installing systemd units"
for unit in every-ear-livekit every-ear-backend every-ear-caddy; do
  sed -e "s#/usr/bin/node#${NODE_BIN}#g" \
      -e "s#/opt/every-ear#${INSTALL_DIR}#g" \
      -e "s#/etc/every-ear#${CONFIG_DIR}#g" \
      "$REPO_DIR/deploy/systemd/${unit}.service" > "/etc/systemd/system/${unit}.service"
done
systemctl daemon-reload

# ---- sysctl + logrotate ----------------------------------------------------
log "Applying network tuning"
install -m 0644 "$REPO_DIR/deploy/sysctl/99-every-ear.conf" /etc/sysctl.d/99-every-ear.conf
sysctl --system >/dev/null

install -m 0644 "$REPO_DIR/deploy/logrotate/every-ear" /etc/logrotate.d/every-ear

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" "$DATA_DIR" "$LOG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"

# ---- start -----------------------------------------------------------------
log "Enabling and starting services"
systemctl enable --now every-ear-livekit every-ear-backend every-ear-caddy

sleep 2
systemctl --no-pager --lines=0 status every-ear-livekit every-ear-backend every-ear-caddy || true

cat <<EOF

✓ Every Ear installed.

  Listener URL : https://${DOMAIN:-$PUBLIC_HOST}:${LISTENER_PORT}/
  Admin URL    : https://${DOMAIN:-$PUBLIC_HOST}:${LISTENER_PORT}/admin.html
  Admin pass   : $ADMIN_PASSWORD

  Config       : $CONFIG_DIR/env
  Data         : $DATA_DIR
  Logs         : journalctl -u every-ear-backend -f

  Health check : ./scripts/doctor.sh
EOF
