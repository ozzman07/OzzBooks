import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchWork, fetchCover, lookupSeriesNumber, OpenLibraryUnavailableError } from '../src/ingestion/enrichment/openLibrary.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
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
    // genre is now mapped through the controlled vocabulary (see
    // genreOptions.ts) rather than the raw top subject string — "Alternate
    // history" hits the History keyword pattern.
    expect(match).toEqual({ genre: 'History', coverId: 42, synopsis: null, series: null })
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

  // Description is deliberately never part of the search response fixture
  // below (see runSearch's own comment: combining `description` with any
  // other field in search.json's `fields=` 500s live on Open Library's
  // side) — synopsis comes from a separate, second request to the
  // matched doc's own /works/<key>.json, keyed off the `key` field the
  // search result carries instead.
  function workResponse(description: unknown) {
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ description }) }
  }

  it('accepts a confident match and returns its genre, cover id, and synopsis', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/works/')) {
          expect(url).toBe('https://openlibrary.org/works/OL123W.json')
          return workResponse('A young thief joins a crew to overthrow the immortal Lord Ruler.')
        }
        return searchResponse([
          {
            key: '/works/OL123W',
            title: 'Mistborn: The Final Empire',
            author_name: ['Brandon Sanderson'],
            subject: ['Fantasy fiction', 'Magic', 'Fiction'],
            cover_i: 12345,
          },
        ])
      }),
    )
    const match = await searchWork('Mistborn The Final Empire', 'Brandon Sanderson')
    // genre is mapped through the controlled vocabulary (genreOptions.ts),
    // scored across the whole subject list: "Fantasy fiction" + "Magic"
    // both score Fantasy, "Fiction" alone matches nothing.
    expect(match).toEqual({
      genre: 'Fantasy',
      coverId: 12345,
      synopsis: 'A young thief joins a crew to overthrow the immortal Lord Ruler.',
      series: null,
    })
  })

  it('handles description as a text-type object ({ value }), not just a plain string', async () => {
    // Open Library's own data is inconsistent about this field's shape.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/works/')) {
          return workResponse({ type: '/type/text', value: 'A young thief joins a crew to overthrow the Lord Ruler.' })
        }
        return searchResponse([
          {
            key: '/works/OL123W',
            title: 'Mistborn: The Final Empire',
            author_name: ['Brandon Sanderson'],
            subject: ['Fantasy fiction'],
            cover_i: 12345,
          },
        ])
      }),
    )
    const match = await searchWork('Mistborn The Final Empire', 'Brandon Sanderson')
    expect(match?.synopsis).toBe('A young thief joins a crew to overthrow the Lord Ruler.')
  })

  it('returns a null synopsis when Open Library has no description at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([
          { title: 'Mistborn: The Final Empire', author_name: ['Brandon Sanderson'], subject: ['Fantasy fiction'], cover_i: 12345 },
        ]),
      ),
    )
    const match = await searchWork('Mistborn The Final Empire', 'Brandon Sanderson')
    expect(match?.synopsis).toBeNull()
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

  it('extracts a series from a "series:X" subject tag (real Open Library shape)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([
          {
            title: 'Dungeon Crawler Carl',
            author_name: ['Matt Dinniman'],
            subject: ['series:Dungeon Crawler Carl', 'genre:LitRPG', 'genre:science fantasy'],
          },
        ]),
      ),
    )
    const match = await searchWork('Dungeon Crawler Carl', 'Matt Dinniman')
    expect(match?.series).toBe('Dungeon Crawler Carl')
  })

  it('matches the "series:" tag case-insensitively and converts hyphens to spaces when the tag has no spaces of its own', async () => {
    // Real Open Library data is inconsistent about casing ("series:" vs
    // "Series:") and sometimes hyphenates a series name as one token
    // ("Six-of-Crows") — both confirmed live.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([
          {
            title: 'Six of Crows',
            author_name: ['Leigh Bardugo'],
            subject: ['Series:Six-of-Crows', 'Series:Grishaverse'],
          },
        ]),
      ),
    )
    const match = await searchWork('Six of Crows', 'Leigh Bardugo')
    // First matching subject wins when a work lists more than one.
    expect(match?.series).toBe('Six of Crows')
  })

  it('does not invent a hyphen-to-space conversion when the tag already mixes hyphens and spaces', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([
          { title: 'Some Book', author_name: ['Some Author'], subject: ['series:Spider-Man Noir'] },
        ]),
      ),
    )
    const match = await searchWork('Some Book', 'Some Author')
    expect(match?.series).toBe('Spider-Man Noir')
  })

  it('returns a null series when no subject is series-tagged — confirmed real gap (The Hunger Games, Dresden Files)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([
          { title: 'The Hunger Games', author_name: ['Suzanne Collins'], subject: ['Science fiction', 'Young adult fiction'] },
        ]),
      ),
    )
    const match = await searchWork('The Hunger Games', 'Suzanne Collins')
    expect(match?.series).toBeNull()
  })

  it('returns null when there are no results at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => searchResponse([])))
    const match = await searchWork('Some Obscure Nonexistent Title Xyz', 'Nobody')
    expect(match).toBeNull()
  })

  it('recovers from a single transient failure instead of giving up on the first try', async () => {
    // The actual real-world case this was built for: one lone timeout
    // stopped an entire ~6000-book overnight backfill after 639 books had
    // already succeeded. A transient blip on the first attempt must not
    // sink the whole book — it should just retry and succeed.
    vi.useFakeTimers()
    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++
        if (callCount === 1) throw new DOMException('The operation timed out.', 'TimeoutError')
        return searchResponse([
          { title: 'Mistborn: The Final Empire', author_name: ['Brandon Sanderson'], subject: ['Fantasy fiction'], cover_i: 1 },
        ])
      }),
    )
    const pending = searchWork('Mistborn The Final Empire', 'Brandon Sanderson')
    await vi.runAllTimersAsync()
    const match = await pending
    expect(match?.coverId).toBe(1)
    expect(callCount).toBe(2) // failed once, succeeded on retry — not 3 (exhausted) or 1 (no retry at all)
  })

  it('treats a 4xx response as "no match" immediately, without retrying or throwing (real case: a degenerate query 422s)', async () => {
    // Real production case: cleanTitleForSearch reduces "The Ian Dex
    // Supernatural Thriller Series: Books 1 - 4 (Las Vegas Paranormal
    // Police Department Box Sets) (Unabridged)" down to a bare "4", which
    // Open Library's search 422s on deterministically, every time. A
    // 4xx is a rejected request, not a transient failure — retrying
    // wastes time, and throwing OpenLibraryUnavailableError would
    // permanently deadlock the rest of the enrichment queue behind this
    // one unmatchable book (that error is deliberately never stamped as
    // attempted, and this book would always be first in line again).
    const fetchMock = vi.fn(async () => ({ ok: false, status: 422, statusText: 'Unprocessable Entity' }))
    vi.stubGlobal('fetch', fetchMock)
    const match = await searchWork('4', null)
    expect(match).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry attempts for a 4xx
  })

  it('throws OpenLibraryUnavailableError after exhausting retries on a non-ok response', async () => {
    // 500 is retried with backoff (see withRetry) before finally being
    // thrown — fake timers let this test observe that eventual failure
    // without waiting out the real multi-second backoff delays.
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })),
    )
    const pending = searchWork('Mistborn', 'Brandon Sanderson').catch((err) => err)
    await vi.runAllTimersAsync()
    const caught = await pending
    expect(caught).toBeInstanceOf(OpenLibraryUnavailableError)
    expect((caught as Error).message).toContain('500')
  })

  it('throws OpenLibraryUnavailableError (not the raw fetch error) after exhausting retries on a network failure/timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }),
    )
    const pending = expect(searchWork('Mistborn', 'Brandon Sanderson')).rejects.toBeInstanceOf(OpenLibraryUnavailableError)
    await vi.runAllTimersAsync()
    await pending
  })
})

describe('lookupSeriesNumber', () => {
  function editionsResponse(entries: Array<{ series?: string[] }>) {
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ entries }) }
  }

  it('extracts a number from an edition series tag naming our series (real Open Library shape: "Dresden Files (1)")', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/editions.json')) {
          expect(url).toBe('https://openlibrary.org/works/OL5685119W/editions.json?limit=50')
          return editionsResponse([{ series: ['Dresden Files (1)'] }, { series: ['The Dresden Files'] }])
        }
        return searchResponse([
          { key: '/works/OL5685119W', title: 'Storm Front', author_name: ['Jim Butcher'], subject: [] },
        ])
      }),
    )
    const number = await lookupSeriesNumber('Storm Front', 'Jim Butcher', 'The Dresden Files')
    expect(number).toBe(1)
  })

  it('ignores an edition series tag for an unrelated series (real shape: a duology alongside its parent universe)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/editions.json')) {
          // "Grishaverse" shares no significant word with "Six of Crows" —
          // its number must never be attached to the wrong series.
          return editionsResponse([{ series: ['Grishaverse #7'] }])
        }
        return searchResponse([
          { key: '/works/OL1W', title: 'Six of Crows', author_name: ['Leigh Bardugo'], subject: [] },
        ])
      }),
    )
    const number = await lookupSeriesNumber('Six of Crows', 'Leigh Bardugo', 'Six of Crows')
    expect(number).toBeNull()
  })

  it('does not match on a single common word shared with an unrelated series (real case: "Bond" alone)', async () => {
    // Real case caught before this shipped: a book's (garbage, pre-existing
    // data issue) author field was itself a folder/category name, not an
    // author — forcing the title-only search fallback, which matched an
    // unrelated Young Bond novel. Its edition tag shared only the single
    // word "bond" with our series name "James Bond - Raymond Benson",
    // enough to falsely pass a plain single-word-overlap check before this
    // fix required 2+ shared words (or a full subset) instead.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/editions.json')) return editionsResponse([{ series: ['Young Bond (1)'] }])
        return searchResponse([{ key: '/works/OL1W', title: 'Silverfin', author_name: ['Charlie Higson'], subject: [] }])
      }),
    )
    const number = await lookupSeriesNumber('Silverfin', 'James Bond Books', 'James Bond - Raymond Benson')
    expect(number).toBeNull()
  })

  it('returns null rather than guessing when matching tags disagree on the number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/editions.json')) {
          return editionsResponse([{ series: ['Dresden Files (1)'] }, { series: ['Dresden Files (2)'] }])
        }
        return searchResponse([
          { key: '/works/OL5685119W', title: 'Storm Front', author_name: ['Jim Butcher'], subject: [] },
        ])
      }),
    )
    const number = await lookupSeriesNumber('Storm Front', 'Jim Butcher', 'The Dresden Files')
    expect(number).toBeNull()
  })

  it('returns null when there is no confident title/author match at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => searchResponse([])))
    const number = await lookupSeriesNumber('Some Obscure Nonexistent Title Xyz', 'Nobody', 'Some Series')
    expect(number).toBeNull()
  })

  it('returns null when the matched work has no key to fetch editions for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        searchResponse([{ title: 'Storm Front', author_name: ['Jim Butcher'], subject: [] }]),
      ),
    )
    const number = await lookupSeriesNumber('Storm Front', 'Jim Butcher', 'The Dresden Files')
    expect(number).toBeNull()
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

  it('throws OpenLibraryUnavailableError (not null) after exhausting retries on a network failure/timeout', async () => {
    // Deliberately distinct from the 404 case above: a missing single
    // cover image is a normal, expected outcome (return null, keep
    // going); a connection failure/timeout means Open Library itself
    // isn't responding, which the caller needs to be able to tell apart.
    // Fake timers here too, for the same reason as searchWork's retry test.
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      }),
    )
    const pending = expect(fetchCover(12345)).rejects.toBeInstanceOf(OpenLibraryUnavailableError)
    await vi.runAllTimersAsync()
    await pending
  })
})
