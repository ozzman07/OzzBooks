import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getComicPage, MAX_CACHED_ARCHIVES } from '../src/ingestion/comicArchiveCache.js'
import { makeTestComic } from './fixtures.js'

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

  it('caches the entry list — a second request for the same book+path does not see bytes rewritten at the same path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-cache-'))
    const cbzPath = path.join(dir, 'comic.cbz')
    await makeTestComic(cbzPath, { pages: ['a.jpg'], comicInfo: null })

    const bookId = randomUUID()
    const first = await getComicPage(bookId, cbzPath, 0)
    expect(first?.buffer.toString()).toBe('page-content-a.jpg')

    // Overwrite the same path with different content — a real .cbz on this
    // app's NAS is never rewritten in place in practice, so the cache
    // deliberately doesn't watch for this; confirms that documented
    // behavior rather than assuming it.
    await makeTestComic(cbzPath, { pages: ['b.jpg'], comicInfo: null })
    const second = await getComicPage(bookId, cbzPath, 0)
    expect(second?.buffer.toString()).toBe('page-content-a.jpg') // still the cached original
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
