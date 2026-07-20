import { getDb, type LocalProgressEntry } from './db'

export async function getLocalProgress(bookId: string): Promise<LocalProgressEntry | undefined> {
  return (await getDb()).get('progress', bookId)
}

export async function getAllLocalProgress(): Promise<LocalProgressEntry[]> {
  return (await getDb()).getAll('progress')
}

export async function putLocalProgress(entry: LocalProgressEntry): Promise<void> {
  await (await getDb()).put('progress', entry)
}

export async function deleteLocalProgress(bookId: string): Promise<void> {
  await (await getDb()).delete('progress', bookId)
}

export async function getUnsyncedProgress(): Promise<LocalProgressEntry[]> {
  const all = await getAllLocalProgress()
  return all.filter((e) => !e.synced)
}

/** Marks a row synced only if it still matches what was actually synced —
 * a newer local write may have landed while the network request was in
 * flight, and that one still needs its own sync attempt. */
export async function markSyncedIfUnchanged(bookId: string, syncedUpdatedAt: string): Promise<void> {
  const db = await getDb()
  const current = await db.get('progress', bookId)
  if (current && current.updatedAt === syncedUpdatedAt) {
    await db.put('progress', { ...current, synced: true })
  }
}
