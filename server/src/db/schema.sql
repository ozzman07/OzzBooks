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
  -- Tracks where series_number came from so a manual correction survives
  -- future rescans, while an automatic value keeps refreshing on every
  -- scan (same as author/series_name already do). NULL means "never
  -- manually touched, free to be (re-)derived."
  series_number_source TEXT CHECK (series_number_source IN ('tag', 'folder', 'manual')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'missing')),
  -- Stamped the moment a book flips active -> missing, cleared back to
  -- NULL the moment it's reactivated (relink, auto-replace, or a plain
  -- rescan finding the file again) — see writeBookAndChapters. Drives the
  -- auto-purge safety net (ingestion/autoPurge.ts): a dedicated column
  -- rather than reading it back out of activity_log, since not every
  -- "marked missing" path (e.g. a Google Drive disconnect) logs an entry.
  missing_since TEXT,
  artwork_thumb_path TEXT,
  artwork_full_path TEXT,
  volume_normalization_gain REAL,
  content_hash TEXT, -- for duplicate detection across sources
  genre TEXT, -- backfilled from Open Library (see ingestion/enrichment/), null until enriched
  synopsis TEXT, -- backfilled alongside genre, same enrichment pass, null until enriched
  -- Stamped on every enrichment attempt, hit or miss, so a backfill pass
  -- doesn't repeatedly re-query the same already-attempted book — a
  -- future "retry failed lookups" action resets this to NULL.
  metadata_enrichment_attempted_at TEXT,
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

-- Singleton (id always 1) — app-wide preferences that don't belong on any
-- one source. Row is seeded below on every startup (idempotent), so
-- callers can always assume it exists without any app-code seeding logic.
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nightly_rescan_enabled INTEGER NOT NULL DEFAULT 0,
  nightly_rescan_time TEXT NOT NULL DEFAULT '02:00', -- HH:MM, 24h, server-local time
  nightly_rescan_last_run_date TEXT, -- YYYY-MM-DD, server-local; null until it has ever run
  -- Drives the Activity Log's "N new" count on Settings — set to now()
  -- whenever the Activity Log page is opened, null until first visited
  -- (everything counts as new until then).
  activity_log_last_viewed_at TEXT,
  -- Safety-net cleanup for the Needs Attention list: a book missing for
  -- longer than auto_purge_after_days gets deleted automatically during
  -- the nightly rescan, same as removeTrashedBooks/autoReplaceMissingBooks
  -- (see ingestion/autoPurge.ts) — defaults on since the whole point of
  -- this 3-tier design is to keep the list from growing forever with no
  -- attention required, but stays configurable/disable-able for anyone
  -- who wants to review every missing book by hand instead.
  auto_purge_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_purge_enabled IN (0, 1)),
  auto_purge_after_days INTEGER NOT NULL DEFAULT 60,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO app_settings (id) VALUES (1);

-- A running record of book-level events worth surfacing to the user —
-- deliberately not a generic audit-everything table (routine "still here,
-- nothing changed" refreshes on every scan are NOT logged, only genuine
-- state changes), so this stays a signal, not noise. No FK to books(id):
-- a 'removed' entry must outlive the book row it describes, hence title/
-- author are snapshotted here rather than joined at read time.
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  book_id TEXT,
  title TEXT NOT NULL,
  author TEXT,
  action TEXT NOT NULL CHECK (action IN ('created', 'relinked', 'missing', 'removed', 'metadata_updated', 'series_updated')),
  detail TEXT,
  -- Millisecond precision ('subsec'), not just datetime('now')'s default
  -- whole-second — the "N new" summary compares this against
  -- app_settings.activity_log_last_viewed_at with a strict >, and several
  -- events logged in the same second as a page view is a realistic case,
  -- not just a test artifact.
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC);
