import { getDb, type CachedCatalogEntry } from './db'
import type { Book } from '../types'

export async function getCachedCatalog(): Promise<CachedCatalogEntry | undefined> {
  return (await getDb()).get('catalogCache', 'catalog')
}

export async function putCachedCatalog(books: Book[], myLibraryIds: string[]): Promise<void> {
  await (await getDb()).put('catalogCache', { id: 'catalog', books, myLibraryIds, fetchedAt: new Date().toISOString() })
}
