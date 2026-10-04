import { getDb, type LocalProgressEntry } from './db'
import { logPlayerEvent } from '../player/playerDebugLog'

// TEMPORARY diagnostic wrapper (see playerDebugLog.ts) — every read/write
// against the IndexedDB 'progress' store logs its own duration and
// success/failure. Specifically watching for the long-background IDB
// zombie-connection theory: a call that takes unusually long (the
// connection stalling before ultimately resolving) or throws here is the
// smoking gun; a normal call should log single-digit-to-low-double-digit
// `ms`.
async function timedProgressCall<T>(label: string, extra: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await fn()
    logPlayerEvent(`progress:${label}`, { ...extra, ms: Date.now() - startedAt })
    return result
  } catch (err) {
    logPlayerEvent(`progress:${label} FAILED`, { ...extra, ms: Date.now() - startedAt, err: String(err) })
    throw err
  }
}

export async function getLocalProgress(bookId: string): Promise<LocalProgressEntry | undefined> {
  return timedProgressCall('get-local', { bookId }, async () => (await getDb()).get('progress', bookId))
}

export async function getAllLocalProgress(): Promise<LocalProgressEntry[]> {
  return timedProgressCall('get-all-local', {}, async () => (await getDb()).getAll('progress'))
}

export async function putLocalProgress(entry: LocalProgressEntry): Promise<void> {
  await timedProgressCall(
    'put-local',
    { bookId: entry.bookId, chapterId: entry.chapterId, updatedAt: entry.updatedAt },
    async () => (await getDb()).put('progress', entry),
  )
}

export async function deleteLocalProgress(bookId: string): Promise<void> {
  await timedProgressCall('delete-local', { bookId }, async () => (await getDb()).delete('progress', bookId))
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
