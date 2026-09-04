import { getDb, type CachedEpubFileEntry } from './db'

export async function getCachedEpubFile(bookId: string): Promise<CachedEpubFileEntry | undefined> {
  return (await getDb()).get('epubFiles', bookId)
}

export async function putCachedEpubFile(entry: CachedEpubFileEntry): Promise<void> {
  await (await getDb()).put('epubFiles', entry)
}

export async function deleteCachedEpubFile(bookId: string): Promise<void> {
  await (await getDb()).delete('epubFiles', bookId)
}

export async function getAllCachedEpubFiles(): Promise<CachedEpubFileEntry[]> {
  return (await getDb()).getAll('epubFiles')
}

// Mirrors audioFileStore's touchLastPlayed — lets an epub participate in
// the generalized least-recently-used eviction (see downloadManager.ts)
// instead of never being evicted at all.
export async function touchEpubLastRead(bookId: string, when: string): Promise<void> {
  const db = await getDb()
  const entry = await db.get('epubFiles', bookId)
  if (entry) await db.put('epubFiles', { ...entry, lastReadAt: when })
}
