import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, dbPath } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  mkdirSync(config.dataDir, { recursive: true })
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8')
  db.exec(schema)
  migrate(db)

  return db
}

// CREATE TABLE IF NOT EXISTS leaves already-existing tables untouched, so
// columns added to `sources` after its initial release need an explicit
// migration for databases created before this point (SQLite has no
// ADD COLUMN IF NOT EXISTS).
function migrate(db: Database.Database): void {
  const sourcesColumns = new Set(
    (db.prepare('PRAGMA table_info(sources)').all() as { name: string }[]).map((c) => c.name),
  )
  const scanSummaryColumns: [string, string][] = [
    ['last_scanned_at', 'TEXT'],
    ['last_scan_found', 'INTEGER'],
    ['last_scan_created', 'INTEGER'],
    ['last_scan_updated', 'INTEGER'],
    ['last_scan_failed', 'INTEGER'],
    ['last_scan_skipped_duplicates', 'INTEGER'],
    ['credentials_expires_at', 'TEXT'],
    [
      'credentials_status',
      "TEXT NOT NULL DEFAULT 'ok' CHECK (credentials_status IN ('ok', 'needs_reconnect'))",
    ],
    ['credentials_account_label', 'TEXT'],
  ]
  for (const [name, type] of scanSummaryColumns) {
    if (!sourcesColumns.has(name)) {
      db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`)
    }
  }

  const booksColumns = new Set(
    (db.prepare('PRAGMA table_info(books)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!booksColumns.has('created_at')) {
    db.exec('ALTER TABLE books ADD COLUMN created_at TEXT')
    // No true creation date exists for books ingested before this column
    // existed — updated_at is the closest available approximation for a
    // one-time backfill. Every book inserted from here on gets a real,
    // never-touched created_at from scanSource's INSERT.
    db.exec('UPDATE books SET created_at = updated_at WHERE created_at IS NULL')
  }
  const booksTextColumns: [string, string][] = [
    ['genre', 'TEXT'],
    ['synopsis', 'TEXT'],
    ['metadata_enrichment_attempted_at', 'TEXT'],
    ['series_number_source', "TEXT CHECK (series_number_source IN ('tag', 'folder', 'manual'))"],
    ['missing_since', 'TEXT'],
    ['narrator', 'TEXT'],
    ['writer', 'TEXT'],
    ['penciller', 'TEXT'],
    ['publisher', 'TEXT'],
  ]
  for (const [name, type] of booksTextColumns) {
    if (!booksColumns.has(name)) {
      db.exec(`ALTER TABLE books ADD COLUMN ${name} ${type}`)
    }
  }

  const appSettingsColumns = new Set(
    (db.prepare('PRAGMA table_info(app_settings)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!appSettingsColumns.has('activity_log_last_viewed_at')) {
    db.exec('ALTER TABLE app_settings ADD COLUMN activity_log_last_viewed_at TEXT')
  }
  if (!appSettingsColumns.has('auto_purge_enabled')) {
    db.exec(
      'ALTER TABLE app_settings ADD COLUMN auto_purge_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_purge_enabled IN (0, 1))',
    )
  }
  if (!appSettingsColumns.has('auto_purge_after_days')) {
    db.exec('ALTER TABLE app_settings ADD COLUMN auto_purge_after_days INTEGER NOT NULL DEFAULT 60')
  }

  // Last step, once every other books column above is guaranteed present —
  // see rebuildBooksTableForEpubSupport's own docstring for why this one
  // can't be a plain ADD COLUMN like everything else in this function.
  if (!booksColumns.has('companion_book_id')) {
    rebuildBooksTableForEpubSupport(db)
  }

  // Same reasoning as the epub gate just above — page_count's absence is
  // the signal this DB predates cbz (comics) support and needs the full
  // rebuild (format CHECK widened to include 'cbz' + page_count added
  // together). Checked against the same booksColumns snapshot captured at
  // the top of this function, so a DB old enough to need both this and the
  // epub rebuild above correctly runs both in one migrate() call.
  if (!booksColumns.has('page_count')) {
    rebuildBooksTableForComicSupport(db)
  }
}

/**
 * SQLite can't widen an existing CHECK constraint (here, `format`'s) via
 * ALTER TABLE — only ADD COLUMN/DROP COLUMN/RENAME are supported, so every
 * other migration in this file gets away with a plain ADD COLUMN, but
 * adding `'epub'` as a valid format needs a full table rebuild: create a
 * new table with the wider CHECK (+ the new companion_book_id column),
 * copy every row across, drop the old table, rename the new one into
 * place. Runs inside a single transaction (all-or-nothing — a failure
 * partway leaves the original table untouched) with foreign key
 * enforcement suspended for its duration (SQLite pragma docs recommend
 * this for any schema surgery that drops/recreates a referenced table;
 * `chapters.book_id`'s FK on `books` — and books' own new self-referential
 * companion_book_id FK — both correctly re-resolve to the renamed table
 * once it's back in place under the name `books`, confirmed via a
 * dedicated migration test).
 *
 * `narrator`, `writer`, `penciller`, and `publisher` are all included below
 * even though they postdate this rebuild's original authorship — each was
 * added to booksTextColumns after this function was first written, and
 * each omission here was a real latent bug: on any DB still needing this
 * exact rebuild, the ADD COLUMN loop above would populate the column, then
 * this rebuild would silently drop it (never selected into books_new).
 * Found and fixed twice now (narrator, then writer/penciller/publisher)
 * while adding a later rebuild that chains onto this one in the same
 * migrate() call for old-enough databases, surfacing the gap immediately
 * via a "no such column" failure in that later rebuild's own SELECT. This
 * function's column list needs the same manual update every time a new
 * column is added to booksTextColumns — there's no way around that with
 * the explicit-column-list approach short of rewriting this to copy
 * PRAGMA table_info(books) at runtime, not done here to keep the change
 * small and match the existing pattern.
 */
function rebuildBooksTableForEpubSupport(db: Database.Database): void {
  const wasForeignKeysOn = db.pragma('foreign_keys', { simple: true }) === 1
  db.pragma('foreign_keys = OFF')
  try {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE books_new (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES sources(id),
          file_path TEXT NOT NULL,
          format TEXT NOT NULL CHECK (format IN ('m4b', 'mp3_folder', 'epub')),
          companion_book_id TEXT REFERENCES books(id),
          title TEXT NOT NULL,
          author TEXT,
          series_name TEXT,
          series_number REAL,
          series_number_source TEXT CHECK (series_number_source IN ('tag', 'folder', 'manual')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'missing')),
          missing_since TEXT,
          artwork_thumb_path TEXT,
          artwork_full_path TEXT,
          volume_normalization_gain REAL,
          content_hash TEXT,
          genre TEXT,
          synopsis TEXT,
          narrator TEXT,
          writer TEXT,
          penciller TEXT,
          publisher TEXT,
          metadata_enrichment_attempted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`
        INSERT INTO books_new (
          id, source_id, file_path, format, companion_book_id, title, author, series_name, series_number,
          series_number_source, status, missing_since, artwork_thumb_path, artwork_full_path,
          volume_normalization_gain, content_hash, genre, synopsis, narrator, writer, penciller, publisher,
          metadata_enrichment_attempted_at, created_at, updated_at
        )
        SELECT
          id, source_id, file_path, format, NULL, title, author, series_name, series_number,
          series_number_source, status, missing_since, artwork_thumb_path, artwork_full_path,
          volume_normalization_gain, content_hash, genre, synopsis, narrator, writer, penciller, publisher,
          metadata_enrichment_attempted_at, created_at, updated_at
        FROM books
      `)
      db.exec('DROP TABLE books')
      db.exec('ALTER TABLE books_new RENAME TO books')
      db.exec('CREATE INDEX IF NOT EXISTS idx_books_source ON books(source_id)')
    })
    rebuild()
  } finally {
    db.pragma(`foreign_keys = ${wasForeignKeysOn ? 'ON' : 'OFF'}`)
  }
}

/**
 * Same problem/technique as rebuildBooksTableForEpubSupport just above —
 * SQLite can't widen format's CHECK via ALTER TABLE, so adding 'cbz' needs
 * the same full-table rebuild, this time also adding page_count in the same
 * pass (comics-only column, same reasoning as companion_book_id riding
 * along with the epub rebuild: one rebuild, not two).
 *
 * Deliberately written against the *current* full column list rather than
 * copy-pasting rebuildBooksTableForEpubSupport's — see that function's own
 * docstring for the column-dropping bug this exact pattern has already bit
 * twice. Being current as of today doesn't make this rebuild immune to the
 * same fate: the next column added to booksTextColumns after this one
 * needs updating here too, same as every earlier rebuild in this file.
 */
function rebuildBooksTableForComicSupport(db: Database.Database): void {
  const wasForeignKeysOn = db.pragma('foreign_keys', { simple: true }) === 1
  db.pragma('foreign_keys = OFF')
  try {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE books_new (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES sources(id),
          file_path TEXT NOT NULL,
          format TEXT NOT NULL CHECK (format IN ('m4b', 'mp3_folder', 'epub', 'cbz')),
          companion_book_id TEXT REFERENCES books(id),
          title TEXT NOT NULL,
          author TEXT,
          series_name TEXT,
          series_number REAL,
          series_number_source TEXT CHECK (series_number_source IN ('tag', 'folder', 'manual')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'missing')),
          missing_since TEXT,
          artwork_thumb_path TEXT,
          artwork_full_path TEXT,
          volume_normalization_gain REAL,
          content_hash TEXT,
          genre TEXT,
          synopsis TEXT,
          narrator TEXT,
          writer TEXT,
          penciller TEXT,
          publisher TEXT,
          page_count INTEGER,
          metadata_enrichment_attempted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`
        INSERT INTO books_new (
          id, source_id, file_path, format, companion_book_id, title, author, series_name, series_number,
          series_number_source, status, missing_since, artwork_thumb_path, artwork_full_path,
          volume_normalization_gain, content_hash, genre, synopsis, narrator, writer, penciller, publisher, page_count,
          metadata_enrichment_attempted_at, created_at, updated_at
        )
        SELECT
          id, source_id, file_path, format, companion_book_id, title, author, series_name, series_number,
          series_number_source, status, missing_since, artwork_thumb_path, artwork_full_path,
          volume_normalization_gain, content_hash, genre, synopsis, narrator, writer, penciller, publisher, NULL,
          metadata_enrichment_attempted_at, created_at, updated_at
        FROM books
      `)
      db.exec('DROP TABLE books')
      db.exec('ALTER TABLE books_new RENAME TO books')
      db.exec('CREATE INDEX IF NOT EXISTS idx_books_source ON books(source_id)')
    })
    rebuild()
  } finally {
    db.pragma(`foreign_keys = ${wasForeignKeysOn ? 'ON' : 'OFF'}`)
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
