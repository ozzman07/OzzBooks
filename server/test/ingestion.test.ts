import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestLibrary, type TestLibrary } from './fixtures.js'

let library: TestLibrary
let dataDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-data-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  library = await buildTestLibrary()
}, 30_000)

describe('ingestion', () => {
  it('scans an MP3-folder book and an M4B book, skips DRM, and orders chapters correctly', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanSource } = await import('../src/ingestion/scan.js')

    const db = getDb()
    const sourceId = randomUUID()
    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      sourceId,
      'local',
      'Test Library',
      library.root,
    )
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any

    const result = await scanSource(source)

    expect(result.created).toBe(6) // mp3-folder + m4b + split book + generic-chapters book + folder-author book + garbled-folder book; DRM file skipped
    expect(result.found).toBe(7) // + the corrupt m4b, which is a candidate but fails to ingest
    expect(result.failed).toBe(1)

    const issues = db.prepare('SELECT * FROM scan_issues WHERE source_id = ?').all(sourceId) as any[]
    expect(issues).toHaveLength(1)
    expect(issues[0].file_path).toBe(library.corruptM4bPath)

    const updatedSource = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any
    expect(updatedSource.last_scan_failed).toBe(1)
    expect(updatedSource.last_scanned_at).toBeTruthy()

    const books = db.prepare('SELECT * FROM books ORDER BY title').all() as any[]
    expect(books).toHaveLength(6)

    const mp3Book = books.find((b) => b.format === 'mp3_folder')
    expect(mp3Book.title).toBe('Project Hail Mary')
    expect(mp3Book.author).toBe('Andy Weir')
    expect(mp3Book.status).toBe('active')

    const mp3Chapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(mp3Book.id) as any[]
    expect(mp3Chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three'])
    expect(mp3Chapters.every((c) => c.start_time === 0)).toBe(true)
    expect(mp3Chapters.every((c) => c.duration > 0)).toBe(true)

    const m4bBook = books.find((b) => b.title === 'Mistborn: The Final Empire')
    expect(m4bBook).toBeTruthy()
    expect(m4bBook.author).toBe('Brandon Sanderson')

    const m4bChapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(m4bBook.id) as any[]
    expect(m4bChapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter One'])
    expect(m4bChapters[0].start_time).toBeCloseTo(0, 1)
    expect(m4bChapters[1].start_time).toBeCloseTo(2, 1)
    // both chapters point at the same underlying file — that's the whole
    // point of the shared-file, time-offset model for M4B
    expect(m4bChapters[0].file_path).toBe(m4bChapters[1].file_path)
    expect(m4bChapters[0].file_path).toBe(library.m4bPath)

    // The "Part 1"/"Part 2" pair must ingest as ONE book (not two), with
    // the part marker stripped from the book title, and one chapter per
    // part pointing at that part's own file.
    const splitBook = books.find((b) => b.title === 'Split Book')
    expect(splitBook).toBeTruthy()
    expect(splitBook.format).toBe('m4b')
    expect(splitBook.author).toBe('Some Author')

    const splitChapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(splitBook.id) as any[]
    expect(splitChapters.map((c) => c.title)).toEqual(['Part 1: Prologue', 'Part 2: Epilogue'])
    expect(splitChapters[0].file_path).toBe(library.splitBookPart1)
    expect(splitChapters[1].file_path).toBe(library.splitBookPart2)
    // each part's chapter offset is relative to its own file, not a global
    // cumulative timeline — same model as the mp3-folder case above
    expect(splitChapters[0].start_time).toBeCloseTo(0, 1)
    expect(splitChapters[1].start_time).toBeCloseTo(0, 1)

    // When each part's own embedded chapter is a generic auto-numbered
    // label restarting per file ("Part 1" in both), prefixing with our own
    // part label would produce "Part 1: Part 1" / "Part 2: Part 1" — a
    // confusing, near-duplicate pair. Expect clean sequential numbering
    // instead.
    const genericBook = books.find((b) => b.title === 'Generic Chapters Book')
    expect(genericBook).toBeTruthy()
    const genericChapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(genericBook.id) as any[]
    expect(genericChapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2'])

    // The author-folder name ("Real Folder Author, Name") should win over
    // the deliberately mismatched embedded tag ("Wrong Tag Author") — the
    // NAS's one-folder-per-author organization is more consistent than tags.
    const folderAuthorBook = books.find((b) => b.title === 'Folder Author Test Book')
    expect(folderAuthorBook).toBeTruthy()
    expect(folderAuthorBook.author).toBe('Real Folder Author, Name')

    // A garbled 8.3-style folder name isn't a trustworthy author — falls
    // back to the embedded tag instead.
    const garbledFolderBook = books.find((b) => b.title === 'Garbled Folder Test Book')
    expect(garbledFolderBook).toBeTruthy()
    expect(garbledFolderBook.author).toBe('Fallback Tag Author')
  }, 30_000)

  it('keeps created_at stable across rescans (unlike updated_at, which every scan bumps)', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanSource } = await import('../src/ingestion/scan.js')
    const { mkdir } = await import('node:fs/promises')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    // A fresh, isolated fixture (not the shared `library`) — reusing
    // library.root here would trip cross-source duplicate detection, since
    // those files are already ingested under a different source_id from
    // the first test in this file.
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ozzbooks-stability-'))
    const bookDir = path.join(tempRoot, 'Stability Author', 'Stability Book')
    await mkdir(bookDir, { recursive: true })
    // Distinct tone/duration from the other fixtures in this file — content
    // hashing is based on file size + byte samples, so an identical tone
    // would collide with another test's fixture and trip cross-source
    // duplicate detection.
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1.5',
      '-c:a',
      'libmp3lame',
      path.join(bookDir, '01.mp3'),
    ])

    const db = getDb()
    const sourceId = randomUUID()
    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      sourceId,
      'local',
      'Stability Test Library',
      tempRoot,
    )
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any

    await scanSource(source)
    const before = db.prepare("SELECT id, created_at FROM books WHERE source_id = ? AND status = 'active'").all(sourceId) as any[]
    expect(before.length).toBeGreaterThan(0)

    await scanSource(source)
    const after = db.prepare("SELECT id, created_at FROM books WHERE source_id = ? AND status = 'active'").all(sourceId) as any[]

    const createdAtById = new Map(before.map((b) => [b.id, b.created_at]))
    for (const book of after) {
      expect(book.created_at).toBe(createdAtById.get(book.id))
    }
  }, 30_000)

  it('marks a book missing on rescan when its file disappears, without deleting it', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanSource } = await import('../src/ingestion/scan.js')
    const { rm } = await import('node:fs/promises')

    const db = getDb()
    const sourceId = randomUUID()
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ozzbooks-missing-'))
    const { mkdir, writeFile } = await import('node:fs/promises')
    const bookDir = path.join(tempRoot, 'Solo Author', 'Solo Book')
    await mkdir(bookDir, { recursive: true })

    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const mp3Path = path.join(bookDir, '01.mp3')
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', '-c:a', 'libmp3lame', mp3Path])

    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      sourceId,
      'local',
      'Missing-file source',
      tempRoot,
    )
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any

    const first = await scanSource(source)
    expect(first.created).toBe(1)

    const bookBefore = db.prepare('SELECT * FROM books WHERE source_id = ?').get(sourceId) as any
    expect(bookBefore.status).toBe('active')

    await rm(bookDir, { recursive: true, force: true })
    const second = await scanSource(source)
    expect(second.markedMissing).toBe(1)

    const bookAfter = db.prepare('SELECT * FROM books WHERE id = ?').get(bookBefore.id) as any
    expect(bookAfter.status).toBe('missing')
    expect(bookAfter.id).toBe(bookBefore.id) // same row, not deleted/recreated
  }, 30_000)
})
