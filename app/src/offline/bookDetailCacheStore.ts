import { getDb, type CachedBookDetailEntry } from './db'
import type { Book } from '../types'

export async function getCachedBookDetail(bookId: string): Promise<CachedBookDetailEntry | undefined> {
  return (await getDb()).get('bookDetailCache', bookId)
}

export async function putCachedBookDetail(bookId: string, book: Book): Promise<void> {
  await (await getDb()).put('bookDetailCache', { bookId, book, fetchedAt: new Date().toISOString() })
}
