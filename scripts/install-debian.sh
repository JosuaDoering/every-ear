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
#     NETCUP_API_KEY                                  # 64-char REST key (ACME DNS-01)
set -euo pipefail

# ---- paths -----------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL_DIR="${INSTALL_DIR:-/opt/every-ear}"
CONFIG_DIR="${CONFIG_DIR:-/etc/every-ear}"
DATA_DIR="${DATA_DIR:-/var/lib/every-ear}"
LOG_DIR="${LOG_DIR:-/var/log/every-ear}"
TLS_DIR="${TLS_DIR:-/etc/every-ear/tls}"
SERVICE_USER="${SERVICE_USER:-every-ear}"

LISTENER_PORT="${LISTENER_PORT:-8443}"
BACKEND_PORT="${BACKEND_PORT:-3000}"

LIVEKIT_VERSION="${LIVEKIT_VERSION:-v1.11.0}"
CADDY_VERSION="${CADDY_VERSION:-v2.11.7}"

ENV_SRC="$REPO_DIR/.env"

log()  { printf '\033[36m→\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root: sudo $0"
[ -f "$REPO_DIR/livekit.yaml" ] || die "Run this from the repository checkout (livekit.yaml not found)."
# The installer copies the built artifacts into INSTALL_DIR. If the checkout is
# the same directory, it would delete its own build output mid-copy.
if [ "$REPO_DIR" = "$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P)" ]; then
  die "The repository lives inside INSTALL_DIR ($INSTALL_DIR). Clone it elsewhere or set INSTALL_DIR to another path."
fi

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

# These two end up verbatim in the Caddyfile (sed below) and in the generated
# env file, so anything with whitespace, braces or newlines must be refused
# here rather than silently turning into extra Caddy directives. DOMAIN must
# also be a real DNS name (at least one dot) because it is what ACME will issue
# a certificate for.
is_host() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; }
is_ipv4() {
  printf '%s' "$1" | grep -Eqx '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}'
}
is_domain() {
  is_host "$1" || return 1
  case "$1" in *.*) ;; *) return 1 ;; esac
  case "$1" in *..*|.*|*.) return 1 ;; esac
  # A numeric value can only be an IPv4 literal, and an IPv4 address cannot
  # receive an ACME certificate. This also rejects malformed ones like
  # 1.2.3.4.5, which would otherwise be treated as a DNS name.
  if printf '%s' "$1" | grep -Eq '^[0-9.]+$'; then return 1; fi
  return 0
}
# Accept a bare IPv4 or a hostname, but a digits-and-dots value must really be
# an IPv4 address — Caddy would otherwise be handed a site address that cannot
# be reached (e.g. 1.2.3.4.5).
if printf '%s' "$PUBLIC_HOST" | grep -Eq '^[0-9.]+$'; then
  is_ipv4 "$PUBLIC_HOST" || die "invalid PUBLIC_HOST: '$PUBLIC_HOST' (not a valid IPv4 address)"
else
  is_host "$PUBLIC_HOST" || die "invalid PUBLIC_HOST: '$PUBLIC_HOST' (use an IPv4 address or hostname)"
fi
if [ -n "$DOMAIN" ]; then
  is_domain "$DOMAIN" || die "invalid DOMAIN: '$DOMAIN' (use a hostname such as events.example.com)"
fi

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

# ---- settings.json ---------------------------------------------------------
# The backend owns settings.json (shared with the desktop app). Seeding it here
# means the admin can immediately use the web interface, and a domain/Netcup
# credentials provided at install time are available for certificate issuance.
log "Writing $DATA_DIR/settings.json"
# Build the JSON with node instead of string concatenation: passwords and API
# keys may legitimately contain quotes or backslashes, which would otherwise
# produce an unparseable settings.json (and an admin lock-out).
SETTINGS_JSON="$(
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  LISTENER_PORT="$LISTENER_PORT" \
  LIVEKIT_API_KEY="$LIVEKIT_API_KEY" \
  LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
  LANGUAGES="${LANGUAGES:-en,de,fr,es}" \
  PUBLIC_HOST="$PUBLIC_HOST" \
  DOMAIN="$DOMAIN" \
  NETCUP_API_KEY="${NETCUP_API_KEY:-}" \
  "$NODE_BIN" -e '
    const env = process.env;
    if (!Number.isInteger(Number(env.LISTENER_PORT)) || Number(env.LISTENER_PORT) < 1 || Number(env.LISTENER_PORT) > 65535) {
      console.error(`invalid LISTENER_PORT: ${env.LISTENER_PORT}`);
      process.exit(1);
    }
    const settings = {
      adminPassword: env.ADMIN_PASSWORD,
      listenerPort: Number(env.LISTENER_PORT),
      livekitApiKey: env.LIVEKIT_API_KEY,
      livekitApiSecret: env.LIVEKIT_API_SECRET,
      languages: env.LANGUAGES,
      preferredInterface: null,
      publicHost: env.PUBLIC_HOST,
      customDomain: env.DOMAIN || null,
      customCertFile: null,
      customKeyFile: null,
      netcupApiKey: env.NETCUP_API_KEY || null,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    process.stdout.write(JSON.stringify(settings, null, 2));
  '
)" || die "Could not build settings.json (check LISTENER_PORT)."
printf '%s\n' "$SETTINGS_JSON" > "$DATA_DIR/settings.json"
"$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "$DATA_DIR/settings.json" || die "Wrote an invalid $DATA_DIR/settings.json"
chmod 0600 "$DATA_DIR/settings.json"

# ---- initial Caddyfile -----------------------------------------------------
# The backend rewrites this on boot and on every settings change; this seed just
# lets Caddy start immediately. Certificate management happens in the web admin.
TLS_LINE="tls internal"
CADDY_HOST="${DOMAIN:-$PUBLIC_HOST}"
log "Writing $DATA_DIR/Caddyfile (host=${CADDY_HOST}, tls internal)"
sed \
  -e "s#__PUBLIC_HOST__#${CADDY_HOST}#g" \
  -e "s#__LISTENER_PORT__#${LISTENER_PORT}#g" \
  -e "s#__BACKEND_PORT__#${BACKEND_PORT}#g" \
  -e "s#__FRONTEND_DIST__#${INSTALL_DIR}/frontend/dist#g" \
  -e "s#__DATA_DIR__#${DATA_DIR}#g" \
  -e "s#__LOG_DIR__#${LOG_DIR}#g" \
  -e "s#__TLS__#${TLS_LINE}#g" \
  "$REPO_DIR/deploy/Caddyfile.tmpl" > "$DATA_DIR/Caddyfile"

# ---- environment file ------------------------------------------------------
log "Writing $CONFIG_DIR/env"
# systemd's EnvironmentFile strips surrounding quotes and never expands
# variables, so the value is wrapped in whichever quote character it does not
# contain. A value with both kinds (or a newline) cannot be represented and is
# rejected loudly instead of silently mangling a secret.
env_line() {
  local name="$1" value="$2"
  case "$value" in
    *$'\n'*) die "value for $name contains a newline, which $CONFIG_DIR/env cannot represent" ;;
  esac
  local has_single=0 has_double=0
  case "$value" in *\'*) has_single=1 ;; esac
  case "$value" in *'"'*) has_double=1 ;; esac
  if [ "$has_single" = 1 ] && [ "$has_double" = 1 ]; then
    die "value for $name contains both ' and \", which $CONFIG_DIR/env cannot represent"
  fi
  if [ "$has_single" = 1 ]; then
    printf '%s="%s"\n' "$name" "$value"
  else
    printf "%s='%s'\n" "$name" "$value"
  fi
}
{
  echo "# Generated by scripts/install-debian.sh — do not edit livekit secret here by hand."
  env_line LIVEKIT_API_KEY "$LIVEKIT_API_KEY"
  env_line LIVEKIT_API_SECRET "$LIVEKIT_API_SECRET"
  env_line LIVEKIT_NODE_IP "$LIVEKIT_NODE_IP"
  env_line PUBLIC_HOST "$PUBLIC_HOST"
  env_line BACKEND_PORT "$BACKEND_PORT"
  env_line ADMIN_PASSWORD "$ADMIN_PASSWORD"
  env_line EVERY_EAR_DATA_DIR "$DATA_DIR"
  env_line EVERY_EAR_LOG_DIR "$LOG_DIR"
  env_line FRONTEND_DIST "$INSTALL_DIR/frontend/dist"
  echo "EVERY_EAR_MANAGE_CADDY=1"
  env_line EVERY_EAR_DEFAULT_BG "$INSTALL_DIR/frontend/dist/bg.jpg"
  env_line LIVEKIT_WEBHOOK_API_KEY "$LIVEKIT_API_KEY"
  env_line LIVEKIT_WEBHOOK_URLS "http://127.0.0.1:${BACKEND_PORT}/api/livekit/webhook"
  if [ -n "${LANGUAGES:-}" ]; then env_line LANGUAGES "$LANGUAGES"; fi
  if [ -n "${LANGUAGE_NAMES:-}" ]; then env_line LANGUAGE_NAMES "$LANGUAGE_NAMES"; fi
  if [ -n "${LANGUAGE_FLAGS:-}" ]; then env_line LANGUAGE_FLAGS "$LANGUAGE_FLAGS"; fi
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then env_line OPENROUTER_API_KEY "$OPENROUTER_API_KEY"; fi
  if [ -n "${OPENROUTER_MODEL:-}" ]; then env_line OPENROUTER_MODEL "$OPENROUTER_MODEL"; fi
  if [ -n "${RATE_LIMIT_GLOBAL_MAX:-}" ]; then env_line RATE_LIMIT_GLOBAL_MAX "$RATE_LIMIT_GLOBAL_MAX"; fi
  if [ -n "${RATE_LIMIT_LISTENER_MAX:-}" ]; then env_line RATE_LIMIT_LISTENER_MAX "$RATE_LIMIT_LISTENER_MAX"; fi
} > "$CONFIG_DIR/env"
chmod 0600 "$CONFIG_DIR/env"

# ---- systemd units ---------------------------------------------------------
log "Installing systemd units"
# `.restart.path` + `.restart.service` are not enabled with the others: the path
# unit only watches for the web admin's restart marker, so enabling it is what
# makes "restart required" actually happen on a headless install.
for unit in every-ear-livekit every-ear-backend every-ear-caddy every-ear-restart; do
  for suffix in service path; do
    src="$REPO_DIR/deploy/systemd/${unit}.${suffix}"
    [ -f "$src" ] || continue
    sed -e "s#/usr/bin/node#${NODE_BIN}#g" \
        -e "s#/opt/every-ear#${INSTALL_DIR}#g" \
        -e "s#/etc/every-ear#${CONFIG_DIR}#g" \
        -e "s#/var/lib/every-ear#${DATA_DIR}#g" \
        "$src" > "/etc/systemd/system/${unit}.${suffix}"
  done
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
systemctl enable --now every-ear-livekit every-ear-backend every-ear-caddy every-ear-restart.path

sleep 2
systemctl --no-pager --lines=0 status every-ear-livekit every-ear-backend every-ear-caddy || true

cat <<EOF

✓ Every Ear installed.

  Listener URL : https://${DOMAIN:-$PUBLIC_HOST}:${LISTENER_PORT}/
  Admin (web)  : http://127.0.0.1:${BACKEND_PORT}/admin.html
  Settings     : http://127.0.0.1:${BACKEND_PORT}/admin-settings.html
  Admin (LAN)  : https://${DOMAIN:-$PUBLIC_HOST}:${LISTENER_PORT}/admin.html
  Admin pass   : $ADMIN_PASSWORD

  Config       : $CONFIG_DIR/env  (settings: $DATA_DIR/settings.json)
  Data         : $DATA_DIR
  Logs         : journalctl -u every-ear-backend -f

  Health check : ./scripts/doctor.sh
EOF
