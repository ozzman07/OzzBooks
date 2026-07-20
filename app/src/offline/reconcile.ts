import * as cloud from '../api/cloudClient'
import { getAllLocalProgress, getLocalProgress, putLocalProgress, deleteLocalProgress } from './progressStore'
import { trySync } from './syncEngine'
import type { LocalProgressEntry } from './db'

function isNewer(a: { updatedAt: string }, b: { updatedAt: string } | undefined): boolean {
  return !b || a.updatedAt > b.updatedAt
}

/** Resolves the actual current progress for one book by comparing local
 * and cloud copies — whichever was captured more recently wins, same
 * last-write-wins rule the server uses. Works offline (falls back to
 * local-only if the cloud is unreachable) and self-heals a stuck pending
 * local write by re-triggering a sync attempt. */
export async function reconcileProgress(token: string | null, bookId: string): Promise<LocalProgressEntry | null> {
  const local = await getLocalProgress(bookId)
  const cloudEntry = token ? await cloud.fetchBookProgress(token, bookId).catch(() => null) : null

  const cloudAsLocal: LocalProgressEntry | null = cloudEntry
    ? {
        bookId: cloudEntry.book_id,
        chapterId: cloudEntry.chapter_id ?? '',
        position: cloudEntry.position,
        updatedAt: cloudEntry.updated_at,
        synced: true,
      }
    : null

  if (local && (!cloudAsLocal || isNewer(local, cloudAsLocal))) {
    if (!local.synced) void trySync(token)
    return local
  }
  if (cloudAsLocal) {
    await putLocalProgress(cloudAsLocal)
    return cloudAsLocal
  }
  return null
}

/** Same idea as reconcileProgress, but for every book at once — used by
 * the Library's Continue Listening shelf. */
export async function reconcileAllProgress(token: string | null): Promise<LocalProgressEntry[]> {
  const [localAll, cloudAll] = await Promise.all([
    getAllLocalProgress(),
    token ? cloud.fetchAllProgress(token).catch(() => []) : Promise.resolve([]),
  ])

  const byBookId = new Map<string, LocalProgressEntry>()
  for (const local of localAll) byBookId.set(local.bookId, local)

  for (const entry of cloudAll) {
    const asLocal: LocalProgressEntry = {
      bookId: entry.book_id,
      chapterId: entry.chapter_id ?? '',
      position: entry.position,
      updatedAt: entry.updated_at,
      synced: true,
    }
    const existing = byBookId.get(entry.book_id)
    if (!existing || isNewer(asLocal, existing)) {
      byBookId.set(entry.book_id, asLocal)
      await putLocalProgress(asLocal)
    }
  }

  // Checked across ALL local rows, not just ones the cloud also returned —
  // if the cloud was unreachable entirely (cloudAll empty), local unsynced
  // rows would otherwise never trigger a retry.
  const hadUnsynced = [...byBookId.values()].some((e) => !e.synced)

  if (hadUnsynced) void trySync(token)

  return [...byBookId.values()]
}

/** Removes a book from the Continue Listening shelf — a deliberate clear
 * (e.g. a stale entry left behind after a rename/relink), not a normal
 * progress write. Local delete always happens first and always succeeds
 * (no network dependency), so the shelf updates immediately even if the
 * cloud delete below fails; a failure there just means a slow reconnect
 * could resurrect the entry from the still-present cloud row on the next
 * reconcile, which is an acceptable rare edge case for a cleanup action —
 * the caller can surface the thrown error and let the user retry. */
export async function removeFromContinueListening(token: string | null, bookId: string): Promise<void> {
  await deleteLocalProgress(bookId)
  if (token) await cloud.deleteProgress(token, bookId)
}
