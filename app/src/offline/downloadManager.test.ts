import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from './db'
import { putCachedAudioFile, getCachedAudioFile, getAllCachedAudioFiles } from './audioFileStore'
import { putCachedEpubFile, getCachedEpubFile } from './epubFileStore'
import { putCachedComicPage, putComicDownload, getCachedComicPagesForBook, getComicDownload } from './comicPageStore'
import { downloadChapter, downloadComicPage, getTotalCachedBytes, getCachedBytesByContentType } from './downloadManager'
import type { Chapter } from '../types'

function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'chap-1',
    bookId: 'book-audio',
    index: 0,
    title: 'Chapter 1',
    startTime: 0,
    duration: 100,
    audioUrl: 'https://example.test/audio.m4b',
    sourceFileId: 'source-1',
    ...overrides,
  }
}

function fakeBlobResponse(sizeBytes: number): Response {
  const blob = new Blob([new Uint8Array(sizeBytes)])
  return new Response(blob, { status: 200 })
}

beforeEach(async () => {
  await resetDbForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getTotalCachedBytes / getCachedBytesByContentType', () => {
  it('sums bytes across audio, epub, and comic pages together', async () => {
    await putCachedAudioFile({
      sourceFileId: 'a1',
      bookId: 'book-a',
      blob: new Blob([new Uint8Array(100)]),
      sizeBytes: 100,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
    })
    await putCachedEpubFile({
      bookId: 'book-e',
      blob: new Blob([new Uint8Array(50)]),
      sizeBytes: 50,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      lastReadAt: '2026-01-01T00:00:00.000Z',
    })
    await putCachedComicPage({
      key: 'book-c:0',
      bookId: 'book-c',
      pageIndex: 0,
      blob: new Blob([new Uint8Array(25)]),
      sizeBytes: 25,
      downloadedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(await getTotalCachedBytes()).toBe(175)
    expect(await getCachedBytesByContentType()).toEqual({ audio: 100, ebook: 50, comics: 25 })
  })
})

describe('ensureBudget (via downloadChapter/downloadComicPage)', () => {
  it('picks the globally oldest cached item for eviction, regardless of format', async () => {
    // Oldest: an audio file. Middle: an epub. Newest: a comic page. A tiny
    // budget forces exactly one eviction — it must be the audio file, not
    // whichever format happens to be checked first.
    await putCachedAudioFile({
      sourceFileId: 'old-audio',
      bookId: 'book-audio-old',
      blob: new Blob([new Uint8Array(40)]),
      sizeBytes: 40,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      lastPlayedAt: '2026-01-01T00:00:00.000Z', // oldest
    })
    await putCachedEpubFile({
      bookId: 'book-epub-mid',
      blob: new Blob([new Uint8Array(40)]),
      sizeBytes: 40,
      downloadedAt: '2026-01-02T00:00:00.000Z',
      lastReadAt: '2026-01-02T00:00:00.000Z', // middle
    })
    await putCachedComicPage({
      key: 'book-comic-new:0',
      bookId: 'book-comic-new',
      pageIndex: 0,
      blob: new Blob([new Uint8Array(40)]),
      sizeBytes: 40,
      downloadedAt: '2026-01-03T00:00:00.000Z',
    })
    await putComicDownload({
      bookId: 'book-comic-new',
      pageCount: 1,
      complete: true,
      startedAt: '2026-01-03T00:00:00.000Z',
      lastReadAt: '2026-01-03T00:00:00.000Z', // newest
    })

    // Used = 120 bytes. Budget = 130 bytes (0.000124 MB). Downloading a new
    // 20-byte chapter would push usage to 140 > 130 — exactly one 40-byte
    // eviction is needed, and it must be the oldest (the audio file).
    const budgetMb = 130 / (1024 * 1024)
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(20)))

    await downloadChapter(makeChapter({ sourceFileId: 'new-audio', bookId: 'book-audio-new' }), budgetMb)

    expect(await getCachedAudioFile('old-audio')).toBeUndefined() // evicted
    expect(await getCachedEpubFile('book-epub-mid')).not.toBeUndefined() // untouched
    expect((await getCachedComicPagesForBook('book-comic-new')).length).toBe(1) // untouched
    expect(await getCachedAudioFile('new-audio')).not.toBeUndefined() // the new download landed
  })

  it("evicts a whole comic issue's pages together, never partially", async () => {
    // Three pages of one old comic, plus one newer audio file that must
    // survive. Budget forces evicting the entire comic (all 3 pages),
    // not just enough individual pages to squeeze by.
    for (let i = 0; i < 3; i++) {
      await putCachedComicPage({
        key: `old-comic:${i}`,
        bookId: 'old-comic',
        pageIndex: i,
        blob: new Blob([new Uint8Array(20)]),
        sizeBytes: 20,
        downloadedAt: '2026-01-01T00:00:00.000Z',
      })
    }
    await putComicDownload({
      bookId: 'old-comic',
      pageCount: 3,
      complete: true,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastReadAt: '2026-01-01T00:00:00.000Z', // oldest
    })
    await putCachedAudioFile({
      sourceFileId: 'newer-audio',
      bookId: 'book-audio',
      blob: new Blob([new Uint8Array(20)]),
      sizeBytes: 20,
      downloadedAt: '2026-01-02T00:00:00.000Z',
      lastPlayedAt: '2026-01-02T00:00:00.000Z', // newer, must survive
    })

    // Used = 80 bytes (60 comic + 20 audio). Budget = 85 bytes. A new
    // 10-byte chapter pushes usage to 90 > 85 — only evicting the full
    // 60-byte comic (not a partial 1-2 pages of it) gets back under budget.
    const budgetMb = 85 / (1024 * 1024)
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(10)))

    await downloadChapter(makeChapter({ sourceFileId: 'second-audio', bookId: 'book-audio' }), budgetMb)

    expect((await getCachedComicPagesForBook('old-comic')).length).toBe(0) // all pages gone
    expect(await getComicDownload('old-comic')).toBeUndefined() // metadata record gone too
    expect(await getCachedAudioFile('newer-audio')).not.toBeUndefined() // untouched
    expect(await getCachedAudioFile('second-audio')).not.toBeUndefined() // the new download landed
  })

  it('leaves existing audio-only eviction behavior unchanged when nothing else is cached', async () => {
    await putCachedAudioFile({
      sourceFileId: 'audio-old',
      bookId: 'book-1',
      blob: new Blob([new Uint8Array(30)]),
      sizeBytes: 30,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
    })
    await putCachedAudioFile({
      sourceFileId: 'audio-new',
      bookId: 'book-2',
      blob: new Blob([new Uint8Array(30)]),
      sizeBytes: 30,
      downloadedAt: '2026-01-02T00:00:00.000Z',
      lastPlayedAt: '2026-01-02T00:00:00.000Z',
    })

    const budgetMb = 50 / (1024 * 1024)
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(10)))

    await downloadChapter(makeChapter({ sourceFileId: 'audio-newest', bookId: 'book-3' }), budgetMb)

    expect(await getCachedAudioFile('audio-old')).toBeUndefined() // oldest evicted
    expect(await getCachedAudioFile('audio-new')).not.toBeUndefined() // survives
    expect(await getCachedAudioFile('audio-newest')).not.toBeUndefined() // new download landed
    expect((await getAllCachedAudioFiles()).length).toBe(2)
  })

  it('rejects a download bigger than the entire budget instead of evicting everything and still failing', async () => {
    await putCachedAudioFile({
      sourceFileId: 'survivor',
      bookId: 'book-1',
      blob: new Blob([new Uint8Array(30)]),
      sizeBytes: 30,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
    })

    const budgetMb = 50 / (1024 * 1024) // 50 bytes total
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(100))) // bigger than the whole budget

    await expect(downloadChapter(makeChapter({ sourceFileId: 'too-big' }), budgetMb)).rejects.toThrow(/larger than your entire storage budget/)

    // Nothing should have been evicted trying (and failing) to make room.
    expect(await getCachedAudioFile('survivor')).not.toBeUndefined()
    expect(await getCachedAudioFile('too-big')).toBeUndefined()
  })
})

describe('downloadChapter chunked fetch', () => {
  it('reassembles a file served across multiple Range-requested chunks (spanning the real 8 MB chunk size)', async () => {
    // 20 MB forces three real requests against the production 8 MB chunk
    // size (8 + 8 + 4), exercising actual boundary math rather than a
    // single request that happens to cover the whole (small) file.
    const total = 20 * 1024 * 1024 + 37 // not a clean multiple, to also prove the tail chunk is sized correctly
    const fullBytes = new Uint8Array(total)
    for (let i = 0; i < total; i++) fullBytes[i] = i % 256
    const requestedRanges: string[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const range = (init?.headers as Record<string, string>).Range
        requestedRanges.push(range)
        const match = /bytes=(\d+)-(\d+)/.exec(range)!
        const start = Number(match[1])
        const end = Math.min(Number(match[2]), total - 1)
        return new Response(new Blob([fullBytes.slice(start, end + 1)]), {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${total}` },
        })
      }),
    )

    await downloadChapter(makeChapter({ sourceFileId: 'chunked-audio' }), 30)

    const stored = await getCachedAudioFile('chunked-audio')
    expect(stored?.sizeBytes).toBe(total)
    expect(requestedRanges.length).toBe(3)

    const storedBytes = new Uint8Array(await stored!.blob.arrayBuffer())
    let matches = true
    for (let i = 0; i < total; i++) {
      if (storedBytes[i] !== fullBytes[i]) {
        matches = false
        break
      }
    }
    expect(matches).toBe(true)
  })

  it('retries a failed chunk before giving up', async () => {
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempts++
        if (attempts < 3) return new Response(null, { status: 503 })
        return new Response(new Blob([new Uint8Array(5)]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-4/5' },
        })
      }),
    )

    await downloadChapter(makeChapter({ sourceFileId: 'retried-audio' }))
    expect(attempts).toBe(3)
    expect(await getCachedAudioFile('retried-audio')).not.toBeUndefined()
  })

  it('gives up after repeated chunk failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))

    await expect(downloadChapter(makeChapter({ sourceFileId: 'failed-audio' }))).rejects.toThrow()
    expect(await getCachedAudioFile('failed-audio')).toBeUndefined()
  })

  it('falls back to using the response directly if the server ignores Range (200 instead of 206)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(30)))

    await downloadChapter(makeChapter({ sourceFileId: 'no-range-audio' }))
    const stored = await getCachedAudioFile('no-range-audio')
    expect(stored?.sizeBytes).toBe(30)
  })
})

describe('downloadComicPage', () => {
  it('creates a comicDownloads metadata record on first page, marked incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(50)))
    await downloadComicPage('book-x', 0, 24)

    const record = await getComicDownload('book-x')
    expect(record?.complete).toBe(false)
    expect(record?.pageCount).toBe(24)
    expect((await getCachedComicPagesForBook('book-x')).length).toBe(1)
  })

  it('is a no-op if the exact page is already cached', async () => {
    const fetchMock = vi.fn(async () => fakeBlobResponse(50))
    vi.stubGlobal('fetch', fetchMock)
    await downloadComicPage('book-y', 0, 10)
    await downloadComicPage('book-y', 0, 10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
