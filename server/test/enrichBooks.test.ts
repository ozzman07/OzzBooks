import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/ingestion/enrichment/openLibrary.js', () => ({
  searchWork: vi.fn(),
  fetchCover: vi.fn(),
}))

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-enrich-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
}, 30_000)

async function insertSource() {
  const { getDb } = await import('../src/db/index.js')
  const db = getDb()
  const id = randomUUID()
  db.prepare("INSERT INTO sources (id, type, label, path_scope) VALUES (?, 'local', 'Test', '/tmp')").run(id)
  return id
}

async function insertBook(
  sourceId: string,
  overrides: Partial<{
    genre: string | null
    artworkThumbPath: string | null
    artworkFullPath: string | null
    attemptedAt: string | null
    status: string
    title: string
    author: string | null
  }> = {},
) {
  const { getDb } = await import('../src/db/index.js')
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO books (
       id, source_id, file_path, format, title, author, status,
       genre, artwork_thumb_path, artwork_full_path, metadata_enrichment_attempted_at
     ) VALUES (?, ?, ?, 'm4b', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    `/fake/${id}.m4b`,
    overrides.title ?? 'Mistborn: The Final Empire',
    overrides.author ?? 'Brandon Sanderson',
    overrides.status ?? 'active',
    overrides.genre ?? null,
    overrides.artworkThumbPath ?? null,
    overrides.artworkFullPath ?? null,
    overrides.attemptedAt ?? null,
  )
  return id
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('enrichBooks', () => {
  it('only selects books missing genre or cover that have not been attempted yet', async () => {
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue(null) // no match either way, we're only checking selection

    const sourceId = await insertSource()
    const missingGenre = await insertBook(sourceId, { genre: null, artworkThumbPath: '/x', artworkFullPath: '/x' })
    const missingCover = await insertBook(sourceId, { genre: 'Fantasy', artworkThumbPath: null, artworkFullPath: null })
    const fullyPopulated = await insertBook(sourceId, { genre: 'Fantasy', artworkThumbPath: '/x', artworkFullPath: '/x' })
    const alreadyAttempted = await insertBook(sourceId, { genre: null, attemptedAt: '2026-01-01T00:00:00Z' })
    const missingBook = await insertBook(sourceId, { genre: null, status: 'missing' })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    const result = await enrichBooks()

    expect(result.attempted).toBe(2) // only missingGenre and missingCover
    const calledIds = vi.mocked(searchWork).mock.calls.length
    expect(calledIds).toBe(2)

    // Sanity: the ones that shouldn't have been touched still have no
    // attempted timestamp stamped by this run (fullyPopulated/missingBook
    // were never candidates; alreadyAttempted keeps its original stamp).
    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    expect((db.prepare('SELECT metadata_enrichment_attempted_at FROM books WHERE id = ?').get(fullyPopulated) as any).metadata_enrichment_attempted_at).toBeNull()
    expect((db.prepare('SELECT metadata_enrichment_attempted_at FROM books WHERE id = ?').get(missingBook) as any).metadata_enrichment_attempted_at).toBeNull()
    expect((db.prepare('SELECT metadata_enrichment_attempted_at FROM books WHERE id = ?').get(alreadyAttempted) as any).metadata_enrichment_attempted_at).toBe('2026-01-01T00:00:00Z')
    expect((db.prepare('SELECT metadata_enrichment_attempted_at FROM books WHERE id = ?').get(missingGenre) as any).metadata_enrichment_attempted_at).toBeTruthy()
    expect((db.prepare('SELECT metadata_enrichment_attempted_at FROM books WHERE id = ?').get(missingCover) as any).metadata_enrichment_attempted_at).toBeTruthy()
  })

  it('populates genre on a confident match and stamps the attempt', async () => {
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue({ genre: 'Fantasy fiction', coverId: null })

    const sourceId = await insertSource()
    const bookId = await insertBook(sourceId, { genre: null, artworkThumbPath: '/existing', artworkFullPath: '/existing' })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    const result = await enrichBooks()

    expect(result.genreUpdated).toBe(1)
    const { getDb } = await import('../src/db/index.js')
    const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any
    expect(row.genre).toBe('Fantasy fiction')
    expect(row.metadata_enrichment_attempted_at).toBeTruthy()
  })

  it('never overwrites an existing cover, even when Open Library returns one', async () => {
    const { searchWork, fetchCover } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue({ genre: null, coverId: 555 })

    const sourceId = await insertSource()
    // Missing genre (so it's a candidate) but already has a cover.
    const bookId = await insertBook(sourceId, { genre: null, artworkThumbPath: '/already-there-thumb', artworkFullPath: '/already-there-full' })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    await enrichBooks()

    expect(fetchCover).not.toHaveBeenCalled()
    const { getDb } = await import('../src/db/index.js')
    const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any
    expect(row.artwork_thumb_path).toBe('/already-there-thumb')
    expect(row.artwork_full_path).toBe('/already-there-full')
  })

  it('marks a book attempted (as a skip) when no confident match is found, without crashing the batch', async () => {
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue(null)

    const sourceId = await insertSource()
    const bookId = await insertBook(sourceId, { genre: null })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    const result = await enrichBooks()

    expect(result.skipped).toBe(1)
    const { getDb } = await import('../src/db/index.js')
    const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any
    expect(row.genre).toBeNull()
    expect(row.metadata_enrichment_attempted_at).toBeTruthy()
  })

  it('counts a failure and still stamps the attempt when the lookup throws, without stopping the batch', async () => {
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork)
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ genre: 'Sci-Fi', coverId: null })

    const sourceId = await insertSource()
    const failingBook = await insertBook(sourceId, { genre: null, title: 'First Book' })
    const okBook = await insertBook(sourceId, { genre: null, title: 'Second Book' })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    const result = await enrichBooks()

    expect(result.failed).toBe(1)
    expect(result.genreUpdated).toBe(1)

    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    expect((db.prepare('SELECT * FROM books WHERE id = ?').get(failingBook) as any).metadata_enrichment_attempted_at).toBeTruthy()
    expect((db.prepare('SELECT * FROM books WHERE id = ?').get(okBook) as any).genre).toBe('Sci-Fi')
  })
})
