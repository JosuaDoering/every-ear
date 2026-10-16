#!/usr/bin/env bash
# Back up Every Ear data (events, codes, languages, AI config, stats,
# backgrounds) to a timestamped tarball. Safe to run while the stack is live —
# the stores use atomic temp-file + rename writes.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/every-ear}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/every-ear}"

[ -d "$DATA_DIR" ] || { echo "No data dir at $DATA_DIR" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/every-ear-$STAMP.tar.gz"
tar -czf "$OUT" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

echo "✓ Backup written: $OUT"
echo "  Restore with:  sudo systemctl stop every-ear-{backend,livekit,caddy}"
echo "                 sudo tar -xzf $OUT -C $(dirname "$DATA_DIR")"
echo "                 sudo chown -R every-ear:every-ear $DATA_DIR"
echo "                 sudo systemctl start every-ear-{backend,livekit,caddy}"
