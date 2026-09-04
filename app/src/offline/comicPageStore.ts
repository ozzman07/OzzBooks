import { getDb, type CachedComicPageEntry, type CachedComicDownloadEntry } from './db'

function pageKey(bookId: string, pageIndex: number): string {
  return `${bookId}:${pageIndex}`
}

export async function getCachedComicPage(bookId: string, pageIndex: number): Promise<CachedComicPageEntry | undefined> {
  return (await getDb()).get('comicPages', pageKey(bookId, pageIndex))
}

export async function getCachedComicPagesForBook(bookId: string): Promise<CachedComicPageEntry[]> {
  return (await getDb()).getAllFromIndex('comicPages', 'bookId', bookId)
}

export async function getAllCachedComicPages(): Promise<CachedComicPageEntry[]> {
  return (await getDb()).getAll('comicPages')
}

export async function putCachedComicPage(entry: CachedComicPageEntry): Promise<void> {
  await (await getDb()).put('comicPages', entry)
}

// Whole-issue eviction unit — every cached page for a book is deleted
// together, never partially (see CachedComicDownloadEntry's doc comment
// in db.ts). Also used for a deliberate "remove download" action, not
// just automatic eviction.
export async function deleteCachedComicPagesForBook(bookId: string): Promise<void> {
  const db = await getDb()
  const pages = await db.getAllFromIndex('comicPages', 'bookId', bookId)
  const tx = db.transaction('comicPages', 'readwrite')
  await Promise.all(pages.map((p) => tx.store.delete(p.key)))
  await tx.done
}

export async function getComicDownload(bookId: string): Promise<CachedComicDownloadEntry | undefined> {
  return (await getDb()).get('comicDownloads', bookId)
}

export async function getAllComicDownloads(): Promise<CachedComicDownloadEntry[]> {
  return (await getDb()).getAll('comicDownloads')
}

export async function putComicDownload(entry: CachedComicDownloadEntry): Promise<void> {
  await (await getDb()).put('comicDownloads', entry)
}

export async function deleteComicDownload(bookId: string): Promise<void> {
  await (await getDb()).delete('comicDownloads', bookId)
}

// Mirrors audioFileStore's touchLastPlayed — bumps the book-level timestamp
// eviction sorts by. A no-op if the book has no comicDownloads record yet
// (nothing to evict, nothing to touch — the opportunistic pre-fetch path
// calls this defensively before any explicit download has ever happened).
export async function touchComicLastRead(bookId: string, when: string): Promise<void> {
  const db = await getDb()
  const entry = await db.get('comicDownloads', bookId)
  if (entry) await db.put('comicDownloads', { ...entry, lastReadAt: when })
}
