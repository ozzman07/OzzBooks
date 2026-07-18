import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchWork, fetchCover } from '../src/ingestion/enrichment/openLibrary.js'

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
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('includes title and author as separate query params', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      expect(parsed.searchParams.get('title')).toBe('Mistborn')
      expect(parsed.searchParams.get('author')).toBe('Brandon Sanderson')
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

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })),
    )
    await expect(searchWork('Mistborn', 'Brandon Sanderson')).rejects.toThrow('500')
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
})
