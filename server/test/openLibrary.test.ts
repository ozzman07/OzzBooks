import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchWork, fetchCover, OpenLibraryUnavailableError } from '../src/ingestion/enrichment/openLibrary.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Real-shaped response fixture, trimmed to the fields the code reads.
function searchResponse(docs: Array<Record<string, unknown>>) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ docs }) }
}

describe('searchWork', () => {
  it('sets a User-Agent identifying the app', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>)['User-Agent']).toContain('OzzBooks')
      return searchResponse([])
    })
    vi.stubGlobal('fetch', fetchMock)
    await searchWork('Mistborn', 'Brandon Sanderson')
    // Called twice: an empty result with an author set triggers the
    // title-only fallback retry (see the dedicated test below) — both
    // requests must carry the identifying header.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries title-only when an author-filtered search finds nothing', async () => {
    // Found live against real library data: Open Library's `author` param
    // is a strict filter, not a ranking hint — a garbage author value
    // (e.g. a folder-derived "History") can zero out results for an
    // otherwise perfectly findable book. The title here has two
    // significant words shared with the real doc's title so the retry's
    // result still clears MIN_MATCH_SCORE on title overlap alone, since
    // the garbage author contributes nothing to the score either way.
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.searchParams.has('author')) return searchResponse([])
      return searchResponse([
        {
          title: 'Grantville Gazette',
          author_name: ['Eric Flint'],
          subject: ['Alternate history'],
          cover_i: 42,
        },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)
    const match = await searchWork('Grantville Gazette Volume IV', 'History')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(match).toEqual({ genre: 'Alternate history', coverId: 42 })
  })

  it('does not retry when no author was supplied in the first place', async () => {
    const fetchMock = vi.fn(async () => searchResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    await searchWork('Some Obscure Nonexistent Title Xyz', null)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the title as the general q param and author as its own separate param', async () => {
    // q= (not the fielded title= param) — the fielded param turned out to
    // be near-exact-match strict against real Open Library data (a plain
    // "Dark Tower VI: Song Of Susannah" found nothing), and author stays
    // its own param rather than folded into q= so a raw " - Author Name"
    // fragment can't be misread as a search-exclusion operator.
    // Only checks the first (author-filtered) request — an empty result
    // triggers the title-only fallback retry, covered separately below.
    let callCount = 0
    const fetchMock = vi.fn(async (url: string) => {
      callCount++
      const parsed = new URL(url)
      expect(parsed.searchParams.get('q')).toBe('Mistborn')
      expect(parsed.searchParams.get('fields')).toContain('subject')
      if (callCount === 1) expect(parsed.searchParams.get('author')).toBe('Brandon Sanderson')
      return searchResponse([])
    })
    vi.stubGlobal('fetch', fetchMock)
    await searchWork('Mistborn', 'Brandon Sanderson')
  })

  it('accepts a confident match and returns its genre + cover id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([
          {
            title: 'Mistborn: The Final Empire',
            author_name: ['Brandon Sanderson'],
            subject: ['Fantasy fiction', 'Magic', 'Fiction'],
            cover_i: 12345,
          },
        ]),
      ),
    )
    const match = await searchWork('Mistborn The Final Empire', 'Brandon Sanderson')
    expect(match).toEqual({ genre: 'Fantasy fiction', coverId: 12345 })
  })

  it('picks the best-scoring candidate, not just the first result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([
          { title: 'Completely Unrelated Book', author_name: ['Someone Else'], subject: ['Nonfiction'], cover_i: 1 },
          {
            title: 'Mistborn: The Final Empire',
            author_name: ['Brandon Sanderson'],
            subject: ['Fantasy fiction'],
            cover_i: 999,
          },
        ]),
      ),
    )
    const match = await searchWork('Mistborn The Final Empire', 'Brandon Sanderson')
    expect(match?.coverId).toBe(999)
  })

  it('rejects a low-confidence match rather than guessing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([
          { title: 'Some Totally Different Novel', author_name: ['Nobody Related'], subject: ['Drama'], cover_i: 1 },
        ]),
      ),
    )
    const match = await searchWork('Mistborn The Final Empire', 'Brandon Sanderson')
    expect(match).toBeNull()
  })

  it('returns null when there are no results at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => searchResponse([])))
    const match = await searchWork('Some Obscure Nonexistent Title Xyz', 'Nobody')
    expect(match).toBeNull()
  })

  it('throws OpenLibraryUnavailableError on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })),
    )
    let caught: unknown
    try {
      await searchWork('Mistborn', 'Brandon Sanderson')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OpenLibraryUnavailableError)
    expect((caught as Error).message).toContain('500')
  })

  it('throws OpenLibraryUnavailableError (not the raw fetch error) on a network failure/timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }),
    )
    await expect(searchWork('Mistborn', 'Brandon Sanderson')).rejects.toBeInstanceOf(OpenLibraryUnavailableError)
  })
})

describe('fetchCover', () => {
  it('fetches from the covers endpoint by id and returns a Buffer', async () => {
    const fakeImageBytes = new Uint8Array([1, 2, 3, 4])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe('https://covers.openlibrary.org/b/id/12345-L.jpg')
        return { ok: true, arrayBuffer: async () => fakeImageBytes.buffer }
      }),
    )
    const buffer = await fetchCover(12345)
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer!.length).toBe(4)
  })

  it('returns null (not a throw) when the cover fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const buffer = await fetchCover(999999)
    expect(buffer).toBeNull()
  })

  it('throws OpenLibraryUnavailableError (not null) on a network failure/timeout', async () => {
    // Deliberately distinct from the 404 case above: a missing single
    // cover image is a normal, expected outcome (return null, keep
    // going); a connection failure/timeout means Open Library itself
    // isn't responding, which the caller needs to be able to tell apart.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }),
    )
    await expect(fetchCover(12345)).rejects.toBeInstanceOf(OpenLibraryUnavailableError)
  })
})
