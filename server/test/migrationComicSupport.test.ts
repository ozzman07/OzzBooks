import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'

// Seeds a database matching the shape a real, already-epub-migrated
// production DB has *today*, before cbz support: companion_book_id and
// narrator both present (format CHECK still limited to
// m4b/mp3_folder/epub), no page_count. This is the realistic case for
// migrate()'s new rebuildBooksTableForComicSupport gate — most real
// databases will hit only this rebuild, not the epub one too (see
// migration.test.ts for the older, pre-epub shape that needs both).
//
// Seeding a non-null narrator here is the regression check for a real bug
// found while writing this rebuild: rebuildBooksTableForEpubSupport's own
// books_new column list was never updated when narrator was added later to
// booksTextColumns, so on a DB that still needed *that* rebuild after
// narrator shipped, the rebuild would silently drop it. This test doesn't
// exercise that old code path (this seed already has companion_book_id, so
// the epub gate doesn't fire) — it instead confirms the new comic rebuild
// doesn't repeat the same mistake for the column list it owns.
function seedPreCbzShapeDatabase(dbFilePath: string) {
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
      metadata_enrichment_attempted_at TEXT,
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
    .prepare("INSERT INTO sources (id, type, label, path_scope) VALUES ('src-1', 'synology', 'Audio Books', '/audio')")
    .run()
  raw
    .prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, author, narrator, content_hash, created_at, updated_at)
       VALUES ('book-1', 'src-1', '/audio/a.m4b', 'm4b', 'Pre-Comic Book', 'Some Author', 'Some Narrator', 'abc123', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO chapters (id, book_id, idx, title, start_time, duration, file_path)
       VALUES ('chap-1', 'book-1', 0, 'Chapter 1', 0, 100, '/audio/a.m4b')`,
    )
    .run()
  raw.close()
}

// Same config-freezes-at-import-time reasoning as migration.test.ts — see
// its comment. Each test file gets its own isolated dataDir/module registry
// under vitest's default per-file isolation.
beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-migration-comic-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  const { dbPath } = await import('../src/config.js')
  seedPreCbzShapeDatabase(dbPath)
}, 30_000)

describe('migrate() rebuilding an already-epub-shaped books table for cbz support', () => {
  it('preserves every existing row and column (including narrator), and accepts the new shape afterward', async () => {
    const { getDb } = await import('../src/db/index.js')
    const db = getDb()

    const book = db.prepare('SELECT * FROM books WHERE id = ?').get('book-1') as any
    expect(book).toMatchObject({
      id: 'book-1',
      source_id: 'src-1',
      file_path: '/audio/a.m4b',
      format: 'm4b',
      title: 'Pre-Comic Book',
      author: 'Some Author',
      // The regression check: narrator must survive this rebuild.
      narrator: 'Some Narrator',
      content_hash: 'abc123',
      created_at: '2026-01-01 00:00:00',
    })
    // companion_book_id already existed pre-rebuild (this seed's whole
    // point) and must still be there, untouched.
    expect(book.companion_book_id).toBeNull()
    // The new column exists and defaults to null for pre-existing rows.
    expect(book.page_count).toBeNull()

    const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get('chap-1') as any
    expect(chapter.book_id).toBe('book-1')

    // The whole point of the rebuild: format='cbz', page_count, and the
    // writer/penciller/publisher columns are now all accepted together.
    db.prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, page_count, writer, penciller, publisher, created_at, updated_at)
       VALUES ('book-2', 'src-1', '/comics/b.cbz', 'cbz', 'New Comic', 24, 'Jeph Loeb', 'Jim Lee', 'DC Comics', datetime('now'), datetime('now'))`,
    ).run()
    const comic = db.prepare('SELECT * FROM books WHERE id = ?').get('book-2') as any
    expect(comic.format).toBe('cbz')
    expect(comic.page_count).toBe(24)
    expect(comic.writer).toBe('Jeph Loeb')
    expect(comic.penciller).toBe('Jim Lee')
    expect(comic.publisher).toBe('DC Comics')

    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('is idempotent — reopening the connection against the now-migrated file does not error or lose data', async () => {
    const { getDb, closeDb } = await import('../src/db/index.js')
    closeDb()

    const db = getDb()
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get('book-1') as any
    expect(book.narrator).toBe('Some Narrator')
  })
})
