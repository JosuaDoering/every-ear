#!/usr/bin/env bash
# Remove the systemd deployment installed by scripts/install-debian.sh.
# Data and configuration are kept unless PURGE=1 is set.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/every-ear}"
CONFIG_DIR="${CONFIG_DIR:-/etc/every-ear}"
DATA_DIR="${DATA_DIR:-/var/lib/every-ear}"
LOG_DIR="${LOG_DIR:-/var/log/every-ear}"
SERVICE_USER="${SERVICE_USER:-every-ear}"
PURGE="${PURGE:-0}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo $0" >&2; exit 1; }

echo "→ Stopping and disabling services…"
systemctl disable --now every-ear-caddy every-ear-backend every-ear-livekit 2>/dev/null || true

echo "→ Removing systemd units…"
rm -f /etc/systemd/system/every-ear-{livekit,backend,caddy}.service
systemctl daemon-reload

echo "→ Removing tuning + logrotate…"
rm -f /etc/sysctl.d/99-every-ear.conf /etc/logrotate.d/every-ear
sysctl --system >/dev/null 2>&1 || true

if [ "$PURGE" = "1" ]; then
  echo "→ PURGE=1: removing application, config and data…"
  rm -rf "$INSTALL_DIR" "$CONFIG_DIR"
  # Keep data by default even on purge? No — purge means everything.
  rm -rf "$DATA_DIR" "$LOG_DIR"
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    userdel "$SERVICE_USER" 2>/dev/null || true
  fi
else
  echo "→ Removing application files (keeping $DATA_DIR and $CONFIG_DIR)…"
  rm -rf "$INSTALL_DIR"
fi

echo "✓ Uninstalled."
