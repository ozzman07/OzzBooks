CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('local', 'synology', 'dropbox', 'google_drive')),
  label TEXT NOT NULL,
  path_scope TEXT NOT NULL,
  credentials TEXT, -- encrypted blob for cloud source OAuth tokens; null for local/synology paths
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
