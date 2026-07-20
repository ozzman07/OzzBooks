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

    expect(result.created).toBe(12) // + mixed-folder loose book + mixed-folder nested book + legitimate "Sourcery" title + "To Delete Test Book" + "Corrupt Cover Book" + disc-set "Disc Book"
    expect(result.found).toBe(13) // + the corrupt m4b, which is a candidate but fails to ingest
    expect(result.failed).toBe(1)

    const issues = db.prepare('SELECT * FROM scan_issues WHERE source_id = ?').all(sourceId) as any[]
    expect(issues).toHaveLength(1)
    expect(issues[0].file_path).toBe(library.corruptM4bPath)

    const updatedSource = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any
    expect(updatedSource.last_scan_failed).toBe(1)
    expect(updatedSource.last_scanned_at).toBeTruthy()

    const books = db.prepare('SELECT * FROM books ORDER BY title').all() as any[]
    expect(books).toHaveLength(12)

    const mp3Book = books.find((b) => b.title === 'Project Hail Mary')
    expect(mp3Book.format).toBe('mp3_folder')
    expect(mp3Book.author).toBe('Andy Weir')
    expect(mp3Book.status).toBe('active')

    const mp3Chapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(mp3Book.id) as any[]
    expect(mp3Chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three'])
    expect(mp3Chapters.every((c) => c.start_time === 0)).toBe(true)
    expect(mp3Chapters.every((c) => c.duration > 0)).toBe(true)

    // A book split across sibling MP3-folder discs ("Disc 1"/"Disc 2") must
    // ingest as ONE book, not two — with chapters in disc-then-track order.
    // Both discs' tracks deliberately restart at 1/2 in the fixture, so a
    // naive global sort-by-track-number (instead of processing folders in
    // order) would produce an ambiguous/interleaved order here instead of
    // the correct one.
    const discBook = books.find((b) => b.title === 'Disc Book')
    expect(discBook).toBeTruthy()
    expect(discBook.format).toBe('mp3_folder')
    expect(discBook.author).toBe('Disc Author')
    expect(discBook.file_path).toBe(library.discBookPart1Dir)

    const discChapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(discBook.id) as any[]
    expect(discChapters.map((c) => c.title)).toEqual([
      'Disc 1 Chapter One',
      'Disc 1 Chapter Two',
      'Disc 2 Chapter One',
      'Disc 2 Chapter Two',
    ])
    expect(discChapters.every((c) => c.start_time === 0)).toBe(true)

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

    // A loose standalone .m4b sitting directly in a folder must not stop
    // sibling subdirectories from also being scanned — this is the actual
    // "Dresden Files" bug: a short-story file alongside 21 book subfolders
    // previously caused all 21 to be silently skipped.
    const looseBook = books.find((b) => b.title === 'Standalone Short Story')
    expect(looseBook).toBeTruthy()
    const nestedBook = books.find((b) => b.title === 'The Series 01 - Book One')
    expect(nestedBook).toBeTruthy()

    // Series name derives from the folder one level above the book's own
    // folder — "The Series 01 - Book One" sits inside "The Series", so
    // that's the series. The loose short story sitting directly in "The
    // Series" folder is only 2 levels deep (Author/The Series), so it must
    // NOT get "The Series" mistaken for its own series — there's no extra
    // nesting level for a loose file the way there is for a subfolder.
    expect(nestedBook.series_name).toBe('The Series')
    expect(looseBook.series_name).toBeNull()

    // A book sitting directly under its author folder (no series layer at
    // all) must also get no series.
    expect(folderAuthorBook.series_name).toBeNull()

    // "zzzSource files" backup folders (kept as a just-in-case original
    // when combining files into one audiobook — the endorsed naming
    // convention going forward) must be excluded entirely.
    const sourceBackupBook = books.find((b) => b.title === 'Should Never Be Ingested')
    expect(sourceBackupBook).toBeUndefined()

    // But a real book whose title merely contains "Source" as a substring
    // must NOT be caught by that exclusion.
    const sourceryBook = books.find((b) => b.title === 'Sourcery')
    expect(sourceryBook).toBeTruthy()

    // "To Delete" backup folders (the second naming convention, found on
    // the real Dresden Files books) must be excluded the same way as
    // "zzzSource files" — the real book next to it still ingests normally.
    const toDeleteBook = books.find((b) => b.title === 'To Delete Test Book')
    expect(toDeleteBook).toBeTruthy()
    expect(toDeleteBook.file_path).toBe(library.toDeleteBookPath)
    const toDeleteBackupBook = books.find((b) => b.title === 'Should Never Be Ingested Either')
    expect(toDeleteBackupBook).toBeUndefined()

    // A corrupt cover.jpg must not fail ingestion of the book itself — it
    // just ends up with no artwork (frontend falls back to a placeholder),
    // same as a book with no cover art at all.
    const corruptCoverBook = books.find((b) => b.title === 'Corrupt Cover Book')
    expect(corruptCoverBook).toBeTruthy()
    expect(corruptCoverBook.status).toBe('active')
    expect(corruptCoverBook.artwork_thumb_path).toBeNull()
    expect(corruptCoverBook.artwork_full_path).toBeNull()
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

  it('auto-relinks a same-source file move by content hash instead of creating a duplicate', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanSource } = await import('../src/ingestion/scan.js')
    const { mkdir, rename } = await import('node:fs/promises')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ozzbooks-relink-'))
    const originalDir = path.join(tempRoot, 'Move Author', 'Move Book')
    await mkdir(originalDir, { recursive: true })
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=1',
      '-c:a',
      'libmp3lame',
      path.join(originalDir, '01.mp3'),
    ])

    const db = getDb()
    const sourceId = randomUUID()
    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      sourceId,
      'local',
      'Relink Test Source',
      tempRoot,
    )
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any

    const first = await scanSource(source)
    expect(first.created).toBe(1)
    const bookBefore = db.prepare('SELECT * FROM books WHERE source_id = ?').get(sourceId) as any
    expect(bookBefore.status).toBe('active')

    // Same reorganization scenario as a user renaming a NAS folder: content
    // is byte-identical, only the path changes.
    const movedDir = path.join(tempRoot, 'Move Author', 'Move Book Reorganized')
    await rename(originalDir, movedDir)

    const second = await scanSource(source)
    expect(second.created).toBe(0) // must NOT create a duplicate book
    expect(second.updated).toBe(1) // the hash match counts as an update, not a create
    expect(second.markedMissing).toBe(0) // must NOT orphan the old row as missing

    const books = db.prepare('SELECT * FROM books WHERE source_id = ?').all(sourceId) as any[]
    expect(books).toHaveLength(1) // no duplicate row
    expect(books[0].id).toBe(bookBefore.id) // same book id — progress/bookmarks/downloads stay valid
    expect(books[0].file_path).toBe(movedDir) // mp3_folder format: file_path is the folder itself
    expect(books[0].status).toBe('active')
  }, 30_000)

  it('auto-relinks a renamed disc-set parent folder by content hash', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanSource } = await import('../src/ingestion/scan.js')
    const { mkdir, rename } = await import('node:fs/promises')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ozzbooks-disc-relink-'))
    const bookDir = path.join(tempRoot, 'Disc Relink Author', 'Disc Relink Book')
    const disc1Dir = path.join(bookDir, 'Disc 1')
    const disc2Dir = path.join(bookDir, 'Disc 2')
    await mkdir(disc1Dir, { recursive: true })
    await mkdir(disc2Dir, { recursive: true })
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=550:duration=1',
      '-c:a',
      'libmp3lame',
      path.join(disc1Dir, '01.mp3'),
    ])
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=560:duration=1',
      '-c:a',
      'libmp3lame',
      path.join(disc2Dir, '01.mp3'),
    ])

    const db = getDb()
    const sourceId = randomUUID()
    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      sourceId,
      'local',
      'Disc Relink Test Source',
      tempRoot,
    )
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any

    const first = await scanSource(source)
    expect(first.created).toBe(1) // one grouped book, not two disc books
    const bookBefore = db.prepare('SELECT * FROM books WHERE source_id = ?').get(sourceId) as any
    expect(bookBefore.status).toBe('active')
    const chaptersBefore = db.prepare('SELECT * FROM chapters WHERE book_id = ?').all(bookBefore.id) as any[]
    expect(chaptersBefore).toHaveLength(2)

    // Renaming the PARENT folder (not an individual disc) — content is
    // byte-identical, matching how a user reorganizing their library
    // actually renames the book-level folder, discs untouched underneath.
    const renamedBookDir = path.join(tempRoot, 'Disc Relink Author', 'Disc Relink Book Reorganized')
    await rename(bookDir, renamedBookDir)

    const second = await scanSource(source)
    expect(second.created).toBe(0) // must NOT create a duplicate
    expect(second.updated).toBe(1)
    expect(second.markedMissing).toBe(0)

    const books = db.prepare('SELECT * FROM books WHERE source_id = ?').all(sourceId) as any[]
    expect(books).toHaveLength(1)
    expect(books[0].id).toBe(bookBefore.id) // same book id — progress/bookmarks/downloads stay valid
    expect(books[0].file_path).toBe(path.join(renamedBookDir, 'Disc 1')) // parts[0] under the renamed parent
    expect(books[0].status).toBe('active')
    const chaptersAfter = db.prepare('SELECT * FROM chapters WHERE book_id = ?').all(bookBefore.id) as any[]
    expect(chaptersAfter).toHaveLength(2)
  }, 30_000)

  it('falls back to two ungrouped books when one disc folder fails validation', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanSource } = await import('../src/ingestion/scan.js')
    const { mkdir } = await import('node:fs/promises')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ozzbooks-disc-fallback-'))
    const bookDir = path.join(tempRoot, 'Fallback Author', 'Fallback Book')
    const disc1Dir = path.join(bookDir, 'Disc 1')
    const disc2Dir = path.join(bookDir, 'Disc 2')
    await mkdir(disc1Dir, { recursive: true })
    await mkdir(disc2Dir, { recursive: true })
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=650:duration=1',
      '-c:a',
      'libmp3lame',
      path.join(disc1Dir, '01.mp3'),
    ])
    // "Disc 2" has a real m4b instead of mp3s — the sibling-name match
    // still fires (the folder names still look like a disc set), but
    // per-folder validation must reject the whole group rather than
    // grouping just Disc 1 — no partial grouping. Each folder must then be
    // scanned and ingested independently.
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:duration=1',
      '-metadata',
      'title=Disc 2 As Its Own Book',
      '-metadata',
      'artist=Fallback Author',
      '-c:a',
      'aac',
      path.join(disc2Dir, 'book.m4b'),
    ])

    const db = getDb()
    const sourceId = randomUUID()
    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      sourceId,
      'local',
      'Disc Fallback Test Source',
      tempRoot,
    )
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any

    const result = await scanSource(source)
    expect(result.created).toBe(2) // ungrouped: two independent books, not one grouped book
    expect(result.failed).toBe(0)

    const books = db.prepare('SELECT * FROM books WHERE source_id = ?').all(sourceId) as any[]
    expect(books).toHaveLength(2)
    const disc1Book = books.find((b) => b.file_path === disc1Dir)
    expect(disc1Book).toBeTruthy()
    expect(disc1Book.format).toBe('mp3_folder')
    const disc2Book = books.find((b) => b.title === 'Disc 2 As Its Own Book')
    expect(disc2Book).toBeTruthy()
    expect(disc2Book.format).toBe('m4b')
  }, 30_000)

  it('ranks relink candidates by title/author word overlap against the missing book', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanSource } = await import('../src/ingestion/scan.js')
    const { findRelinkCandidates } = await import('../src/ingestion/relink.js')
    const { mkdir, rm } = await import('node:fs/promises')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ozzbooks-rank-'))
    async function makeMp3Book(dir: string, freq: number) {
      await mkdir(dir, { recursive: true })
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${freq}:duration=1`,
        '-c:a',
        'libmp3lame',
        path.join(dir, '01.mp3'),
      ])
    }

    const targetDir = path.join(tempRoot, 'Jane Doe', 'Great Adventure')
    await makeMp3Book(targetDir, 200)

    const db = getDb()
    const sourceId = randomUUID()
    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      sourceId,
      'local',
      'Ranking Test Source',
      tempRoot,
    )
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any

    await scanSource(source)
    const missingBook = db.prepare('SELECT * FROM books WHERE source_id = ?').get(sourceId) as any
    expect(missingBook.title).toBe('Great Adventure')
    expect(missingBook.author).toBe('Jane Doe')

    // Remove the original so it's genuinely missing, then add decoy files
    // directly to disk without rescanning — unclaimed by any book row,
    // which is what findRelinkCandidates needs to consider them.
    await rm(targetDir, { recursive: true, force: true })
    await scanSource(source) // marks it missing

    const goodMatchDir = path.join(tempRoot, 'Jane Doe', 'Great Adventure Retitled')
    await makeMp3Book(goodMatchDir, 210)
    const weakMatchDir = path.join(tempRoot, 'Jane Doe', 'Totally Unrelated Story')
    await makeMp3Book(weakMatchDir, 220)
    const noMatchDir = path.join(tempRoot, 'Unrelated Author', 'Random Book')
    await makeMp3Book(noMatchDir, 230)

    const missingBookAfter = db.prepare('SELECT * FROM books WHERE id = ?').get(missingBook.id) as any
    expect(missingBookAfter.status).toBe('missing')

    const candidates = await findRelinkCandidates(source, missingBookAfter)
    const paths = candidates.map((c) => c.path)

    // Shares both title words ("great"/"adventure") and the author folder
    // ("jane"/"doe") — should outrank the folder that only shares the
    // author.
    const goodIndex = paths.findIndex((p) => p.includes('Great Adventure Retitled'))
    const weakIndex = paths.findIndex((p) => p.includes('Totally Unrelated Story'))
    expect(goodIndex).toBeGreaterThanOrEqual(0)
    expect(weakIndex).toBeGreaterThanOrEqual(0)
    expect(goodIndex).toBeLessThan(weakIndex)

    // No word overlap at all (different author folder, unrelated title) —
    // filtered out entirely rather than ranked last.
    expect(paths.some((p) => p.includes('Random Book'))).toBe(false)
  }, 30_000)

  it('fails cleanly with no provider registered for a non-local source type, without touching local sources', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanSource } = await import('../src/ingestion/scan.js')

    const db = getDb()
    const sourceId = randomUUID()
    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      sourceId,
      'google_drive',
      'Unimplemented Drive Source',
      'some-remote-folder-id',
    )
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any

    const result = await scanSource(source)
    expect(result).toEqual({ found: 0, created: 0, updated: 0, markedMissing: 0, skippedDuplicates: 0, failed: 1 })

    const issues = db.prepare('SELECT * FROM scan_issues WHERE source_id = ?').all(sourceId) as any[]
    expect(issues).toHaveLength(1)
    expect(issues[0].error).toMatch(/no provider registered/i)

    const updatedSource = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as any
    expect(updatedSource.last_scan_failed).toBe(1)
    expect(updatedSource.last_scanned_at).toBeTruthy()

    // No books were created for this source, and it must not have
    // touched any other source's books.
    const books = db.prepare('SELECT * FROM books WHERE source_id = ?').all(sourceId) as any[]
    expect(books).toHaveLength(0)
  })
})
