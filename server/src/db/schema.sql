CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('local', 'synology', 'dropbox', 'google_drive')),
  label TEXT NOT NULL,
  path_scope TEXT NOT NULL,
  credentials TEXT, -- encrypted blob for cloud source OAuth tokens; null for local/synology paths
  credentials_expires_at TEXT, -- plaintext, not sensitive; access-token expiry for proactive refresh
  credentials_status TEXT NOT NULL DEFAULT 'ok' CHECK (credentials_status IN ('ok', 'needs_reconnect')),
  credentials_account_label TEXT, -- display only, e.g. "connected as name@gmail.com"
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Summary of the most recent scan, surfaced in the UI as index status.
  -- Null until the first scan runs.
  last_scanned_at TEXT,
  last_scan_found INTEGER,
  last_scan_created INTEGER,
  last_scan_updated INTEGER,
  last_scan_failed INTEGER,
  last_scan_skipped_duplicates INTEGER
);

-- Per-file failures from the most recent scan of a source (e.g. a corrupt
-- M4B with no moov atom, or a truncated embedded cover image). Cleared and
-- repopulated on every scan of that source, so this always reflects current
-- state rather than accumulating stale history.
CREATE TABLE IF NOT EXISTS scan_issues (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  error TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scan_issues_source ON scan_issues(source_id);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  file_path TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('m4b', 'mp3_folder')),
  title TEXT NOT NULL,
  author TEXT,
  series_name TEXT,
  series_number REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'missing')),
  artwork_thumb_path TEXT,
  artwork_full_path TEXT,
  volume_normalization_gain REAL,
  content_hash TEXT, -- for duplicate detection across sources
  -- Set once at first ingestion and never touched again (unlike updated_at,
  -- which every rescan bumps even for unchanged books) — this is what
  -- "Recently added" sorting in the UI is based on.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  start_time REAL NOT NULL,
  duration REAL NOT NULL,
  file_path TEXT NOT NULL -- for mp3_folder books each chapter is its own file; for m4b all share the book's file_path
);

CREATE INDEX IF NOT EXISTS idx_books_source ON books(source_id);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
