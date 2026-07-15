#!/bin/bash
# Restores the most recent backup into a scratch copy and spot-checks it
# has sane data. Meant to be run by hand every so often — an untested
# backup can fail silently for months and only get discovered when
# actually needed, so this turns "restore and eyeball it" into a
# one-command check instead of a from-scratch chore.
#
# Usage: scripts/verify-backup.sh [local|nas]   (defaults to local)

set -euo pipefail

SOURCE="${1:-local}"
DATA_DIR="${OZZBOOKS_DATA_DIR:-/Users/jimosborn/OzzBooksData}"

case "$SOURCE" in
  local) BACKUP_DIR="$DATA_DIR/backups" ;;
  nas) BACKUP_DIR="/Volumes/Books/OzzBooks-Backups" ;;
  *) echo "usage: $0 [local|nas]" >&2; exit 1 ;;
esac

LATEST="$(find "$BACKUP_DIR" -maxdepth 1 -name 'ingestion-*.sqlite3' -print0 2>/dev/null \
  | xargs -0 ls -t 2>/dev/null | head -n 1)"

if [ -z "$LATEST" ]; then
  echo "[verify] no backups found in $BACKUP_DIR" >&2
  exit 1
fi

SCRATCH="$(mktemp -t ozzbooks-verify).sqlite3"
cp "$LATEST" "$SCRATCH"

echo "[verify] checking: $LATEST"
echo

sqlite3 "$SCRATCH" <<'SQL'
.headers on
.mode column
SELECT
  (SELECT COUNT(*) FROM sources) AS sources,
  (SELECT COUNT(*) FROM books)   AS books,
  (SELECT COUNT(*) FROM chapters) AS chapters;
SQL

echo
echo "[verify] sample titles:"
sqlite3 "$SCRATCH" "SELECT title, author FROM books ORDER BY created_at LIMIT 5;"

rm -f "$SCRATCH"
echo
echo "[verify] OK — backup opened and returned sane-looking data"
