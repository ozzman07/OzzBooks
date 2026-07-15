#!/bin/bash
# Daily backup of the ingestion database (sources, books, chapters, series
# data, relink/match history). Artwork is deliberately excluded — it's
# regenerated from the NAS source files on every rescan, so it's not
# irreplaceable the way the DB is.
#
# Uses `sqlite3 .backup`, not `cp`, because the DB runs in WAL mode: a raw
# file copy can miss committed data still sitting in the -wal file and
# produce a corrupt snapshot. `.backup` is WAL-aware and safe to run while
# the server is live.
#
# Writes to two places that fail independently:
#   - local (same disk as the live DB): fast recovery from a bad migration,
#     ingestion bug, or accidental delete
#   - NAS (separate physical device): the actual disaster-recovery copy,
#     survives the Mac mini's disk dying
# NAS being unmounted is not treated as fatal — it self-heals on the next
# scheduled run rather than needing anyone to notice and intervene.

set -euo pipefail

DATA_DIR="${OZZBOOKS_DATA_DIR:-/Users/jimosborn/OzzBooksData}"
DB_PATH="$DATA_DIR/ingestion.sqlite3"
LOCAL_BACKUP_DIR="$DATA_DIR/backups"
NAS_BACKUP_DIR="/Volumes/Books/OzzBooks-Backups"
RETENTION_DAYS=30

TIMESTAMP="$(date +%Y-%m-%d)"
SNAPSHOT_NAME="ingestion-${TIMESTAMP}.sqlite3"

if [ ! -f "$DB_PATH" ]; then
  echo "[backup] DB not found at $DB_PATH, aborting" >&2
  exit 1
fi

mkdir -p "$LOCAL_BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$LOCAL_BACKUP_DIR/$SNAPSHOT_NAME'"
echo "[backup] wrote local snapshot: $LOCAL_BACKUP_DIR/$SNAPSHOT_NAME"

if [ -d "/Volumes/Books" ]; then
  mkdir -p "$NAS_BACKUP_DIR"
  cp "$LOCAL_BACKUP_DIR/$SNAPSHOT_NAME" "$NAS_BACKUP_DIR/$SNAPSHOT_NAME"
  echo "[backup] wrote NAS snapshot: $NAS_BACKUP_DIR/$SNAPSHOT_NAME"
else
  echo "[backup] NAS not mounted, skipping off-machine copy for today" >&2
fi

prune() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -name 'ingestion-*.sqlite3' -mtime "+${RETENTION_DAYS}" -print -delete
}

prune "$LOCAL_BACKUP_DIR"
[ -d "/Volumes/Books" ] && prune "$NAS_BACKUP_DIR"

echo "[backup] done"
