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
