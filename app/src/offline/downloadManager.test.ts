import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { resetDbForTests } from './db'
import { putCachedAudioFile, getCachedAudioFile, getAllCachedAudioFiles, putTransferProgress } from './audioFileStore'
import { getAudioChunkBlob, getAudioManifest, hasAudioChunk, putAudioChunk } from './audioChunkStore'
import { putCachedEpubFile, getCachedEpubFile } from './epubFileStore'
import { putCachedComicPage, putComicDownload, getCachedComicPagesForBook, getComicDownload } from './comicPageStore'
import {
  downloadChapter,
  downloadComicPage,
  getTotalCachedBytes,
  getCachedBytesByContentType,
  DOWNLOAD_CHUNK_BYTES,
} from './downloadManager'
import { installFakeCacheStorage } from '../../test/fakeCacheStorage'
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

// Metadata-only seed for tests that only care about eviction/budget
// bookkeeping, not real playable bytes — deleteCachedAudioFile deleting
// nonexistent chunk cache entries is a harmless no-op.
async function seedAudioFile(opts: {
  sourceFileId: string
  bookId: string
  sizeBytes: number
  downloadedAt: string
  lastPlayedAt: string
}) {
  await putCachedAudioFile({ ...opts, chunkCount: 1 })
}

// vitest/chai's toEqual on large TypedArrays is catastrophically slow —
// it enumerates every index as a generic object property (confirmed via a
// real OOM crash whose stack trace was entirely V8's for-in/GetOwnKeys
// machinery), not a bulk byte compare. Buffer.compare() is a fast native
// memcmp; use this for any multi-MB-scale byte comparison in these tests.
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length, 'byte length mismatch').toBe(expected.length)
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected)), 'byte content mismatch').toBe(0)
}

async function readAllChunks(sourceFileId: string, chunkCount: number): Promise<Uint8Array> {
  const blobs: Blob[] = []
  for (let i = 0; i < chunkCount; i++) {
    const blob = await getAudioChunkBlob(sourceFileId, i)
    if (!blob) throw new Error(`missing chunk ${i}`)
    blobs.push(blob)
  }
  return new Uint8Array(await new Blob(blobs).arrayBuffer())
}

beforeEach(async () => {
  await resetDbForTests()
  installFakeCacheStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getTotalCachedBytes / getCachedBytesByContentType', () => {
  it('sums bytes across audio, epub, and comic pages together', async () => {
    await seedAudioFile({
      sourceFileId: 'a1',
      bookId: 'book-a',
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
    await seedAudioFile({
      sourceFileId: 'old-audio',
      bookId: 'book-audio-old',
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

    await downloadChapter(makeChapter({ sourceFileId: 'new-audio', bookId: 'book-audio-new' }), 'm4b', budgetMb)

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
    await seedAudioFile({
      sourceFileId: 'newer-audio',
      bookId: 'book-audio',
      sizeBytes: 20,
      downloadedAt: '2026-01-02T00:00:00.000Z',
      lastPlayedAt: '2026-01-02T00:00:00.000Z', // newer, must survive
    })

    // Used = 80 bytes (60 comic + 20 audio). Budget = 85 bytes. A new
    // 10-byte chapter pushes usage to 90 > 85 — only evicting the full
    // 60-byte comic (not a partial 1-2 pages of it) gets back under budget.
    const budgetMb = 85 / (1024 * 1024)
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(10)))

    await downloadChapter(makeChapter({ sourceFileId: 'second-audio', bookId: 'book-audio' }), 'm4b', budgetMb)

    expect((await getCachedComicPagesForBook('old-comic')).length).toBe(0) // all pages gone
    expect(await getComicDownload('old-comic')).toBeUndefined() // metadata record gone too
    expect(await getCachedAudioFile('newer-audio')).not.toBeUndefined() // untouched
    expect(await getCachedAudioFile('second-audio')).not.toBeUndefined() // the new download landed
  })

  it('leaves existing audio-only eviction behavior unchanged when nothing else is cached', async () => {
    await seedAudioFile({
      sourceFileId: 'audio-old',
      bookId: 'book-1',
      sizeBytes: 30,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
    })
    await seedAudioFile({
      sourceFileId: 'audio-new',
      bookId: 'book-2',
      sizeBytes: 30,
      downloadedAt: '2026-01-02T00:00:00.000Z',
      lastPlayedAt: '2026-01-02T00:00:00.000Z',
    })

    const budgetMb = 50 / (1024 * 1024)
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(10)))

    await downloadChapter(makeChapter({ sourceFileId: 'audio-newest', bookId: 'book-3' }), 'm4b', budgetMb)

    expect(await getCachedAudioFile('audio-old')).toBeUndefined() // oldest evicted
    expect(await getCachedAudioFile('audio-new')).not.toBeUndefined() // survives
    expect(await getCachedAudioFile('audio-newest')).not.toBeUndefined() // new download landed
    expect((await getAllCachedAudioFiles()).length).toBe(2)
  })

  it('rejects a download bigger than the entire budget instead of evicting everything and still failing', async () => {
    await seedAudioFile({
      sourceFileId: 'survivor',
      bookId: 'book-1',
      sizeBytes: 30,
      downloadedAt: '2026-01-01T00:00:00.000Z',
      lastPlayedAt: '2026-01-01T00:00:00.000Z',
    })

    const budgetMb = 50 / (1024 * 1024) // 50 bytes total
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(100))) // bigger than the whole budget

    await expect(
      downloadChapter(makeChapter({ sourceFileId: 'too-big' }), 'm4b', budgetMb),
    ).rejects.toThrow(/larger than your entire storage budget/)

    // Nothing should have been evicted trying (and failing) to make room,
    // and no chunk should have been written for the rejected download either
    // (budget is checked before the first chunk is ever persisted).
    expect(await getCachedAudioFile('survivor')).not.toBeUndefined()
    expect(await getCachedAudioFile('too-big')).toBeUndefined()
    expect(await hasAudioChunk('too-big', 0)).toBe(false)
  })
})

describe('downloadChapter chunked fetch', () => {
  it('writes a file served across multiple Range-requested chunks as separate Cache Storage entries (spanning the real 8 MB chunk size)', async () => {
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

    await downloadChapter(makeChapter({ sourceFileId: 'chunked-audio' }), 'm4b', 30)

    const stored = await getCachedAudioFile('chunked-audio')
    expect(stored?.sizeBytes).toBe(total)
    expect(stored?.chunkCount).toBe(3)
    expect(requestedRanges.length).toBe(3)

    const manifest = await getAudioManifest('chunked-audio')
    expect(manifest).toEqual({ totalSize: total, chunkSize: DOWNLOAD_CHUNK_BYTES, chunkCount: 3, mimeType: 'audio/mp4' })

    const storedBytes = await readAllChunks('chunked-audio', 3)
    expectBytesEqual(storedBytes, fullBytes)
  })

  it('retries when the connection drops mid-body-read, not just when the initial fetch fails', async () => {
    // Regression test for a real production failure: headers arrive fine
    // (res.ok is true), but the connection drops while streaming the
    // body, so res.blob() itself rejects — this must be retried exactly
    // like a failed fetch(), not left to propagate past the retry logic.
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempts++
        const shouldFailBody = attempts < 3
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (shouldFailBody) {
                controller.error(new TypeError('Load failed'))
                return
              }
              controller.enqueue(new Uint8Array(5))
              controller.close()
            },
          }),
          { status: 206, headers: { 'Content-Range': 'bytes 0-4/5' } },
        )
      }),
    )

    await downloadChapter(makeChapter({ sourceFileId: 'body-drop-audio' }), 'm4b')
    expect(attempts).toBe(3)
    expect(await getCachedAudioFile('body-drop-audio')).not.toBeUndefined()
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

    await downloadChapter(makeChapter({ sourceFileId: 'retried-audio' }), 'm4b')
    expect(attempts).toBe(3)
    expect(await getCachedAudioFile('retried-audio')).not.toBeUndefined()
  })

  it('gives up after repeated chunk failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))

    await expect(downloadChapter(makeChapter({ sourceFileId: 'failed-audio' }), 'm4b')).rejects.toThrow()
    expect(await getCachedAudioFile('failed-audio')).toBeUndefined()
  })

  it('falls back to using the response directly if the server ignores Range (200 instead of 206)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(30)))

    await downloadChapter(makeChapter({ sourceFileId: 'no-range-audio' }), 'm4b')
    const stored = await getCachedAudioFile('no-range-audio')
    expect(stored?.sizeBytes).toBe(30)
    expect(stored?.chunkCount).toBe(1)
  })

  it('resumes from existing transfer progress instead of re-fetching already-written chunks', async () => {
    const total = 20 * 1024 * 1024 + 37
    const fullBytes = new Uint8Array(total)
    for (let i = 0; i < total; i++) fullBytes[i] = i % 256
    const chunkCount = 3

    // Simulate chunk 0 already having been written by a prior, interrupted
    // attempt (real chunk data present + a matching progress row) — a
    // fresh call should only fetch chunks 1 and 2.
    await putAudioChunk('resumed-audio', 0, new Blob([fullBytes.slice(0, DOWNLOAD_CHUNK_BYTES)]))
    await putTransferProgress({
      sourceFileId: 'resumed-audio',
      bookId: 'book-audio',
      chunksWritten: 1,
      chunkCount,
      totalSize: total,
      mimeType: 'audio/mp4',
    })

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

    await downloadChapter(makeChapter({ sourceFileId: 'resumed-audio' }), 'm4b', 30)

    // Only the two remaining chunks (1 and 2) were actually requested.
    expect(requestedRanges.length).toBe(2)
    const stored = await getCachedAudioFile('resumed-audio')
    expect(stored?.chunkCount).toBe(3)
    const storedBytes = await readAllChunks('resumed-audio', 3)
    expectBytesEqual(storedBytes, fullBytes)
  })
})

describe('downloadChapter mime type resolution', () => {
  it('uses the server Content-Type when present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Blob([new Uint8Array(10)]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })),
    )
    await downloadChapter(makeChapter({ sourceFileId: 'mime-explicit' }), 'm4b')
    expect((await getAudioManifest('mime-explicit'))?.mimeType).toBe('audio/mpeg')
  })

  it('falls back to the book format when the server sends no Content-Type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(10)))
    await downloadChapter(makeChapter({ sourceFileId: 'mime-mp3-folder' }), 'mp3_folder')
    expect((await getAudioManifest('mime-mp3-folder'))?.mimeType).toBe('audio/mpeg')
  })

  it('falls back to the default mime type when neither is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeBlobResponse(10)))
    await downloadChapter(makeChapter({ sourceFileId: 'mime-unknown' }), undefined)
    expect((await getAudioManifest('mime-unknown'))?.mimeType).toBe('audio/mp4')
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
