CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- book_id is an opaque reference to a book on the (separate) file-serving
-- API — no real foreign key is possible across services, matching the
-- architecture split in Claude.md.
CREATE TABLE IF NOT EXISTS progress (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  position JSONB NOT NULL, -- {type: 'timestamp'|'cfi', value}
  chapter_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);

-- Bookmarks are a separate, deliberate action from continuous position
-- (see Claude.md) — own table, never overwritten by progress syncs.
CREATE TABLE IF NOT EXISTS bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  position JSONB NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS downloads (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_played_at TIMESTAMPTZ,
  size_bytes BIGINT,
  PRIMARY KEY (user_id, book_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  storage_budget_mb INTEGER NOT NULL DEFAULT 2000,
  playback_speed REAL NOT NULL DEFAULT 1.0,
  skip_silence_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stubbed ahead of Phase 4 (full e-reader UX) — intentionally scaffolded
-- now per Claude.md so no migration is needed later. Not wired to any API
-- endpoint yet.
CREATE TABLE IF NOT EXISTS annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  cfi_range TEXT NOT NULL,
  note_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reading_prefs (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('e-ink', 'light', 'dark', 'sepia')),
  font TEXT,
  margins JSONB
);

-- Reserved ahead of Phase 3c (fine-grained ebook sync) — book-level, not
-- user-scoped, since audio<->CFI alignment is structural to the book.
CREATE TABLE IF NOT EXISTS book_position_map (
  book_id TEXT PRIMARY KEY,
  audio_timestamp DOUBLE PRECISION,
  epub_cfi TEXT
);
