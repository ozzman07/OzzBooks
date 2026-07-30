import { getDb, type CachedBookLocationsEntry } from './db'

export async function getCachedLocations(bookId: string): Promise<CachedBookLocationsEntry | undefined> {
  return (await getDb()).get('bookLocations', bookId)
}

export async function putCachedLocations(bookId: string, locations: string): Promise<void> {
  await (await getDb()).put('bookLocations', { bookId, locations, savedAt: new Date().toISOString() })
}
