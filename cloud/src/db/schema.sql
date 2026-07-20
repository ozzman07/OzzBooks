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

-- Playlists unify "queue" and "playlist" into one concept. Every user gets
-- exactly one reserved "Up Next" playlist at signup (is_reserved = true),
-- which can't be renamed or deleted — it's the queue for ad-hoc "play this
-- next" actions. Ordinary playlists are is_reserved = false.
--
-- owner_id (not user_id) and playlist_items having its own id (not a
-- (playlist_id, book_id) composite key) are both deliberate: they leave
-- room for a future "share a playlist" feature (a collaborator table
-- keyed off playlist_id, and duplicate/multi-add support) without a
-- migration — not building sharing now, just not blocking it later.
CREATE TABLE IF NOT EXISTS playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_reserved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforces "exactly one Up Next per user" at the database level (race-proof
-- under concurrent signups, unlike an app-level check-then-insert) — a
-- partial index only constrains rows where is_reserved is true, so it
-- doesn't limit how many ordinary named playlists a user can have.
CREATE UNIQUE INDEX IF NOT EXISTS one_reserved_playlist_per_owner
  ON playlists (owner_id) WHERE is_reserved;

-- book_id is TEXT, not a foreign key, matching progress/bookmarks/downloads
-- above — book records live in server/'s own SQLite, not here.
CREATE TABLE IF NOT EXISTS playlist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS playlist_items_playlist_id_position
  ON playlist_items (playlist_id, position);

-- Backfill for accounts created before this feature shipped — the
-- signup handler only creates Up Next for *new* signups (auth.ts), so
-- every pre-existing user would otherwise have no reserved playlist at
-- all. Idempotent (WHERE NOT IN excludes anyone already covered), so
-- safe to run on every boot alongside the rest of this file.
INSERT INTO playlists (owner_id, name, is_reserved)
SELECT id, 'Up Next', true FROM users
WHERE id NOT IN (SELECT owner_id FROM playlists WHERE is_reserved = true);

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
