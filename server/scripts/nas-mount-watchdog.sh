#!/bin/bash
# Watchdog for the Synology SMB share at /Volumes/Books — the three
# local/synology sources all have file_path/path_scope values baked in
# under this exact path (see OzzBooksData/ingestion.sqlite3), so losing
# this mount breaks every scan and every book read with a plain ENOENT,
# not an obvious "NAS disconnected" error.
#
# Real incidents this is responding to: once after a Mac mini restart (a
# stale, empty /Volumes/Books directory — not a real mount — forced the
# share to remount as /Volumes/Books-1 instead, which needed a one-time
# `sudo rmdir /Volumes/Books` to clear), and once mid-session with no
# restart at all (the SMB connection just dropped — a network blip or the
# Synology sleeping/rebooting — and macOS only auto-mounts at login, so it
# never reconnected on its own). Runs every 10 minutes via launchd (see
# ~/Library/LaunchAgents/com.ozzbooks.nas-watchdog.plist).
#
# Deliberately does NOT try to fix a stale-blocking-directory situation
# itself — that needs `sudo rmdir /Volumes/Books`, which this unattended
# script has no way to run. It only attempts the same benign reconnect
# that already works once nothing is blocking the path, and logs clearly
# when that's not enough so a human notices instead of every scan just
# silently failing until someone happens to check Settings.

set -euo pipefail

SHARE_URL="smb://192.168.1.200/Books"
MOUNT_POINT="/Volumes/Books"

if mount | grep -q " on ${MOUNT_POINT} (smbfs"; then
  exit 0
fi

echo "[nas-watchdog] ${MOUNT_POINT} is not mounted — attempting reconnect"
open "$SHARE_URL"

# `open` hands off to Finder and returns immediately — give the mount a
# few seconds to actually land before checking.
sleep 8

if mount | grep -q " on ${MOUNT_POINT} (smbfs"; then
  echo "[nas-watchdog] reconnected successfully"
else
  echo "[nas-watchdog] still not mounted after reconnect attempt — may need manual intervention (e.g. a stale /Volumes/Books directory blocking the real mount — run 'sudo rmdir /Volumes/Books' if so, then retry)" >&2
fi
