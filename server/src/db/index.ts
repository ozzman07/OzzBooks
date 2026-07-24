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
  ]
  for (const [name, type] of booksTextColumns) {
    if (!booksColumns.has(name)) {
      db.exec(`ALTER TABLE books ADD COLUMN ${name} ${type}`)
    }
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
