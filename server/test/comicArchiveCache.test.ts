import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getComicPage, MAX_CACHED_ARCHIVES } from '../src/ingestion/comicArchiveCache.js'
import { makeTestComic } from './fixtures.js'

// yauzl's ESM namespace can't be spied on directly (Vitest/Node both
// reject redefining a builtin-style module's exports) — mocking the
// module with a counting wrapper around the real openPromise is the
// supported way to observe how many times comicArchiveCache actually
// opens the underlying archive.
let openPromiseCallCount = 0
vi.mock('yauzl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yauzl')>()
  return {
    ...actual,
    openPromise: (...args: Parameters<typeof actual.openPromise>) => {
      openPromiseCallCount++
      return actual.openPromise(...args)
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getComicPage', () => {
  it('returns the right page bytes and content-type, natural-sorted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-cache-'))
    const cbzPath = path.join(dir, 'comic.cbz')
    await makeTestComic(cbzPath, { pages: ['page1.jpg', 'page2.png', 'page10.jpg'], comicInfo: null })

    const bookId = randomUUID()
    expect(await getComicPage(bookId, cbzPath, 0)).toMatchObject({ contentType: 'image/jpeg' })
    const page0 = await getComicPage(bookId, cbzPath, 0)
    expect(page0?.buffer.toString()).toBe('page-content-page1.jpg')
    const page1 = await getComicPage(bookId, cbzPath, 1)
    expect(page1?.contentType).toBe('image/png')
    expect(page1?.buffer.toString()).toBe('page-content-page2.png')
    const page2 = await getComicPage(bookId, cbzPath, 2)
    expect(page2?.buffer.toString()).toBe('page-content-page10.jpg')
  })

  it('returns null for an out-of-range page index', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-cache-'))
    const cbzPath = path.join(dir, 'comic.cbz')
    await makeTestComic(cbzPath, { pages: ['only.jpg'], comicInfo: null })

    const bookId = randomUUID()
    expect(await getComicPage(bookId, cbzPath, 5)).toBeNull()
    expect(await getComicPage(bookId, cbzPath, -1)).toBeNull()
  })

  it('caches the entry index but reads page bytes live from disk on each request', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-cache-'))
    const cbzPath = path.join(dir, 'comic.cbz')
    await makeTestComic(cbzPath, { pages: ['a.jpg'], comicInfo: null })

    const bookId = randomUUID()
    const first = await getComicPage(bookId, cbzPath, 0)
    expect(first?.buffer.toString()).toBe('page-content-a.jpg')

    // Only the entry index (names/offsets) is cached — page bytes are read
    // on demand via a kept-open random-access handle, not buffered upfront
    // in memory (that upfront full-file read was the actual bug: it made a
    // large archive slow enough to blow past the reader's load timeout).
    // A real .cbz on this app's NAS is never rewritten in place in
    // practice (only relinked, which changes file_path and correctly
    // triggers a reload — see the relink test below), so this reflects an
    // accepted tradeoff rather than a guarded-against scenario.
    await makeTestComic(cbzPath, { pages: ['b.jpg'], comicInfo: null })
    const second = await getComicPage(bookId, cbzPath, 0)
    expect(second?.buffer.toString()).toBe('page-content-b.jpg')
  })

  it('self-heals when the same book id gets a new file_path (a relink)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-cache-'))
    const originalPath = path.join(dir, 'original.cbz')
    await makeTestComic(originalPath, { pages: ['original-page.jpg'], comicInfo: null })
    const relinkedPath = path.join(dir, 'relinked.cbz')
    await makeTestComic(relinkedPath, { pages: ['relinked-page.jpg'], comicInfo: null })

    const bookId = randomUUID()
    const before = await getComicPage(bookId, originalPath, 0)
    expect(before?.buffer.toString()).toBe('page-content-original-page.jpg')

    // Same bookId, different filePath — must reload rather than keep
    // serving pages from the old archive.
    const after = await getComicPage(bookId, relinkedPath, 0)
    expect(after?.buffer.toString()).toBe('page-content-relinked-page.jpg')
  })

  it('de-dupes concurrent loads of the same uncached book (prefetch fires several page requests at once)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-cache-'))
    const cbzPath = path.join(dir, 'comic.cbz')
    await makeTestComic(cbzPath, { pages: ['page1.jpg', 'page2.jpg', 'page3.jpg'], comicInfo: null })

    const bookId = randomUUID()
    const countBefore = openPromiseCallCount

    // Simulates the reader's own prefetch: pages 0/1/2 requested together
    // before any of them has had a chance to populate the cache.
    const [p0, p1, p2] = await Promise.all([
      getComicPage(bookId, cbzPath, 0),
      getComicPage(bookId, cbzPath, 1),
      getComicPage(bookId, cbzPath, 2),
    ])

    expect(p0?.buffer.toString()).toBe('page-content-page1.jpg')
    expect(p1?.buffer.toString()).toBe('page-content-page2.jpg')
    expect(p2?.buffer.toString()).toBe('page-content-page3.jpg')
    // The whole point: one archive open serving all three, not three
    // independent (and independently slow, for a large archive) opens.
    expect(openPromiseCallCount - countBefore).toBe(1)
  })

  it('evicts the least-recently-used archive once the cache is full', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-cache-'))
    const bookIds = Array.from({ length: MAX_CACHED_ARCHIVES }, () => randomUUID())
    const paths: string[] = []
    for (let i = 0; i < bookIds.length; i++) {
      const p = path.join(dir, `comic-${i}.cbz`)
      await makeTestComic(p, { pages: [`page-${i}.jpg`], comicInfo: null })
      paths.push(p)
      await getComicPage(bookIds[i], p, 0) // load each into the cache, filling it exactly
    }

    // One more distinct book pushes the cache over MAX_CACHED_ARCHIVES,
    // evicting the least-recently-used entry — bookIds[0], never touched
    // again since it was first loaded.
    const oneMorePath = path.join(dir, 'one-more.cbz')
    await makeTestComic(oneMorePath, { pages: ['one-more-page.jpg'], comicInfo: null })
    await getComicPage(randomUUID(), oneMorePath, 0)

    // Overwrite bookIds[0]'s original path with different content — if it
    // was evicted (expected), the next request re-reads from disk and sees
    // the new content; if it was NOT evicted (a bug), the stale cached
    // entry would still return the original bytes.
    await makeTestComic(paths[0], { pages: ['page-0-rewritten.jpg'], comicInfo: null })
    const reloaded = await getComicPage(bookIds[0], paths[0], 0)
    expect(reloaded?.buffer.toString()).toBe('page-content-page-0-rewritten.jpg')
  })
})
