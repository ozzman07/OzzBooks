import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Keeps the real OpenLibraryUnavailableError class (not just searchWork/
// fetchCover mocked out) — enrichBooks.ts does `err instanceof
// OpenLibraryUnavailableError` against this same mocked module path, so a
// mock that dropped the class entirely would make that check see
// `undefined` and throw a TypeError instead of behaving as tested below.
vi.mock('../src/ingestion/enrichment/openLibrary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ingestion/enrichment/openLibrary.js')>()
  return {
    ...actual,
    searchWork: vi.fn(),
    fetchCover: vi.fn(),
  }
})

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
    synopsis: string | null
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
       genre, synopsis, artwork_thumb_path, artwork_full_path, metadata_enrichment_attempted_at
     ) VALUES (?, ?, ?, 'm4b', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    `/fake/${id}.m4b`,
    overrides.title ?? 'Mistborn: The Final Empire',
    overrides.author ?? 'Brandon Sanderson',
    overrides.status ?? 'active',
    overrides.genre ?? null,
    overrides.synopsis ?? null,
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
    const fullyPopulated = await insertBook(sourceId, {
      genre: 'Fantasy',
      synopsis: 'Already has a synopsis',
      artworkThumbPath: '/x',
      artworkFullPath: '/x',
    })
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

  it('strips trailing "- Author" and parenthetical noise before querying Open Library', async () => {
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue(null)

    const sourceId = await insertSource()
    await insertBook(sourceId, { genre: null, title: "Beauty's Release (read by George Holmes)" })
    await insertBook(sourceId, { genre: null, title: 'Congo - Michael Crichton' })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    await enrichBooks()

    const cleanedTitles = vi.mocked(searchWork).mock.calls.map((call) => call[0])
    expect(cleanedTitles).toContain("Beauty's Release")
    expect(cleanedTitles).toContain('Congo')
  })

  it('strips a leading "Series N -" prefix, keeping the real title after it', async () => {
    // Confirmed directly against Open Library: the old behavior (stripping
    // everything AFTER the dash, same regex as the "Congo - Michael
    // Crichton" case above) queried "Cinder Spires 1" and got zero
    // results; querying "The Aeronaut's Windlass" found it immediately.
    // This is this library's dominant series-title tagging convention, the
    // mirror image of the trailing-suffix case.
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue(null)

    const sourceId = await insertSource()
    await insertBook(sourceId, { genre: null, title: "Cinder Spires 1 - The Aeronaut's Windlass" })
    await insertBook(sourceId, { genre: null, title: 'Dresden Files 1 - Storm Front' })
    // A real in-title number (a year, not a series position) must NOT be
    // misread as a series-number prefix — same plausibility ceiling as
    // deriveSeriesNumberFromName's documented "Odyssey Series/1997 - 3001
    // The Final Odyssey" case.
    await insertBook(sourceId, { genre: null, title: '1997 - 3001 The Final Odyssey' })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    await enrichBooks()

    const cleanedTitles = vi.mocked(searchWork).mock.calls.map((call) => call[0])
    // The leading-article strip (already existing behavior, applied last)
    // still runs on the newly-exposed title, same as any other book's.
    expect(cleanedTitles).toContain("Aeronaut's Windlass")
    expect(cleanedTitles).toContain('Storm Front')
    expect(cleanedTitles).toContain('1997')
  })

  it('populates genre on a confident match and stamps the attempt', async () => {
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue({ genre: 'Fantasy fiction', coverId: null, synopsis: null })

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

  it('populates synopsis on a confident match, same as genre', async () => {
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue({
      genre: null,
      coverId: null,
      synopsis: 'A wizard for hire in modern-day Chicago.',
    })

    const sourceId = await insertSource()
    const bookId = await insertBook(sourceId, { genre: null, artworkThumbPath: '/existing', artworkFullPath: '/existing' })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    const result = await enrichBooks()

    expect(result.synopsisUpdated).toBe(1)
    const { getDb } = await import('../src/db/index.js')
    const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any
    expect(row.synopsis).toBe('A wizard for hire in modern-day Chicago.')
  })

  it('never overwrites an existing synopsis, even when Open Library returns one', async () => {
    const { searchWork } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue({ genre: 'Fantasy fiction', coverId: null, synopsis: 'A different synopsis' })

    const sourceId = await insertSource()
    // Missing genre (so it's a candidate) but already has a synopsis.
    const bookId = await insertBook(sourceId, {
      genre: null,
      synopsis: 'Already had this synopsis',
      artworkThumbPath: '/existing',
      artworkFullPath: '/existing',
    })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    const result = await enrichBooks()

    expect(result.synopsisUpdated).toBe(0)
    const { getDb } = await import('../src/db/index.js')
    const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any
    expect(row.synopsis).toBe('Already had this synopsis')
  })

  it('never overwrites an existing cover, even when Open Library returns one', async () => {
    const { searchWork, fetchCover } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork).mockResolvedValue({ genre: null, coverId: 555, synopsis: null })

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
      .mockResolvedValueOnce({ genre: 'Sci-Fi', coverId: null, synopsis: null })

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

  it('stops the run early on OpenLibraryUnavailableError, leaving the rest unattempted for next time', async () => {
    const { searchWork, OpenLibraryUnavailableError } = await import('../src/ingestion/enrichment/openLibrary.js')
    vi.mocked(searchWork)
      .mockResolvedValueOnce({ genre: 'Fantasy', coverId: null, synopsis: null }) // succeeds first
      .mockRejectedValueOnce(new OpenLibraryUnavailableError('Open Library search request failed or timed out'))
      .mockResolvedValueOnce({ genre: 'Mystery', coverId: null, synopsis: null }) // must never be reached

    const sourceId = await insertSource()
    const okBook = await insertBook(sourceId, { genre: null, title: 'First Book' })
    const unreachedBook1 = await insertBook(sourceId, { genre: null, title: 'Second Book' })
    const unreachedBook2 = await insertBook(sourceId, { genre: null, title: 'Third Book' })

    const { enrichBooks } = await import('../src/ingestion/enrichment/enrichBooks.js')
    const result = await enrichBooks()

    expect(result.abortedDueToUnavailability).toBe(true)
    expect(result.attempted).toBe(1)
    expect(result.genreUpdated).toBe(1)
    expect(searchWork).toHaveBeenCalledTimes(2) // never reached the third book

    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    expect((db.prepare('SELECT * FROM books WHERE id = ?').get(okBook) as any).genre).toBe('Fantasy')
    // Left un-stamped on purpose so the next run — nightly or a manual
    // Settings retry — picks these up again instead of treating a
    // never-actually-attempted book as a settled no-match.
    expect((db.prepare('SELECT * FROM books WHERE id = ?').get(unreachedBook1) as any).metadata_enrichment_attempted_at).toBeNull()
    expect((db.prepare('SELECT * FROM books WHERE id = ?').get(unreachedBook2) as any).metadata_enrichment_attempted_at).toBeNull()
  })
})
