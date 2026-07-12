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

    expect(result.created).toBe(2) // mp3-folder book + m4b book; DRM file skipped
    expect(result.found).toBe(2)

    const books = db.prepare('SELECT * FROM books ORDER BY title').all() as any[]
    expect(books).toHaveLength(2)

    const mp3Book = books.find((b) => b.format === 'mp3_folder')
    expect(mp3Book.title).toBe('Project Hail Mary')
    expect(mp3Book.author).toBe('Andy Weir')
    expect(mp3Book.status).toBe('active')

    const mp3Chapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(mp3Book.id) as any[]
    expect(mp3Chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three'])
    expect(mp3Chapters.every((c) => c.start_time === 0)).toBe(true)
    expect(mp3Chapters.every((c) => c.duration > 0)).toBe(true)

    const m4bBook = books.find((b) => b.format === 'm4b')
    expect(m4bBook.title).toBe('Mistborn: The Final Empire')
    expect(m4bBook.author).toBe('Brandon Sanderson')

    const m4bChapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(m4bBook.id) as any[]
    expect(m4bChapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter One'])
    expect(m4bChapters[0].start_time).toBeCloseTo(0, 1)
    expect(m4bChapters[1].start_time).toBeCloseTo(2, 1)
    // both chapters point at the same underlying file — that's the whole
    // point of the shared-file, time-offset model for M4B
    expect(m4bChapters[0].file_path).toBe(m4bChapters[1].file_path)
    expect(m4bChapters[0].file_path).toBe(library.m4bPath)
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
