import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'

// Seeds a database matching the *pre-epub* books table shape (no
// companion_book_id, format CHECK limited to m4b/mp3_folder) — this is
// what every real database created before this feature shipped actually
// looks like on disk. migrate() (db/index.ts) must detect this old shape
// and run the one-time rebuild described in rebuildBooksTableForEpubSupport,
// rather than the plain ADD COLUMN path every other migration uses.
function seedOldShapeDatabase(dbFilePath: string) {
  const raw = new Database(dbFilePath)
  raw.pragma('foreign_keys = ON')
  raw.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      path_scope TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE books (
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
      content_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      title TEXT NOT NULL,
      start_time REAL NOT NULL,
      duration REAL NOT NULL,
      file_path TEXT NOT NULL
    );
    CREATE INDEX idx_books_source ON books(source_id);
  `)
  raw
    .prepare("INSERT INTO sources (id, type, label, path_scope) VALUES ('src-1', 'local', 'Old Library', '/old')")
    .run()
  raw
    .prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, author, content_hash, created_at, updated_at)
       VALUES ('book-1', 'src-1', '/old/a.m4b', 'm4b', 'Pre-Migration Book', 'Some Author', 'abc123', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO chapters (id, book_id, idx, title, start_time, duration, file_path)
       VALUES ('chap-1', 'book-1', 0, 'Chapter 1', 0, 100, '/old/a.m4b')`,
    )
    .run()
  raw.close()
}

// config.ts freezes dataDir/dbPath at module-load time (a plain object
// literal read once from process.env), so OZZBOOKS_DATA_DIR must be set —
// and the old-shape file must exist on disk — before anything in this file
// first imports config.js/db/index.js. Matches the beforeAll pattern used
// by every other multi-test file in this suite (e.g. ingestion.test.ts).
beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-migration-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  const { dbPath } = await import('../src/config.js')
  seedOldShapeDatabase(dbPath)
}, 30_000)

describe('migrate() rebuilding the books table for epub support', () => {
  it('preserves every existing row and column, and accepts the new shape afterward', async () => {
    const { getDb } = await import('../src/db/index.js')
    const db = getDb()

    const book = db.prepare('SELECT * FROM books WHERE id = ?').get('book-1') as any
    expect(book).toMatchObject({
      id: 'book-1',
      source_id: 'src-1',
      file_path: '/old/a.m4b',
      format: 'm4b',
      title: 'Pre-Migration Book',
      author: 'Some Author',
      content_hash: 'abc123',
      created_at: '2026-01-01 00:00:00',
    })
    // The new column exists and defaults to null for pre-existing rows.
    expect(book.companion_book_id).toBeNull()

    // Chapters (a separate table, untouched by the rebuild) survived and
    // its FK into the rebuilt books table still resolves.
    const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get('chap-1') as any
    expect(chapter.book_id).toBe('book-1')

    // The whole point of the rebuild: format='epub' is now accepted.
    db.prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, created_at, updated_at)
       VALUES ('book-2', 'src-1', '/old/b.epub', 'epub', 'New Epub Book', datetime('now'), datetime('now'))`,
    ).run()
    expect((db.prepare('SELECT * FROM books WHERE id = ?').get('book-2') as any).format).toBe('epub')

    // And the self-referential link column actually works.
    db.prepare('UPDATE books SET companion_book_id = ? WHERE id = ?').run('book-2', 'book-1')
    expect((db.prepare('SELECT * FROM books WHERE id = ?').get('book-1') as any).companion_book_id).toBe('book-2')

    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('cascade-deletes chapters through the rebuilt books table, same as before the rebuild', async () => {
    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    db.prepare('DELETE FROM books WHERE id = ?').run('book-1')
    expect(db.prepare('SELECT * FROM chapters WHERE id = ?').get('chap-1')).toBeUndefined()
  })

  it('is idempotent — reopening the connection against the now-migrated file does not error or lose data', async () => {
    const { getDb, closeDb } = await import('../src/db/index.js')
    closeDb()

    // A fresh getDb() re-runs schema.sql (CREATE TABLE IF NOT EXISTS,
    // already a no-op) and migrate() against the SAME file, now already in
    // the new shape — this is exactly what a real server restart does, and
    // must not attempt the rebuild a second time or throw.
    const db = getDb()
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get('book-2') as any
    expect(book.title).toBe('New Epub Book')
  })
})
