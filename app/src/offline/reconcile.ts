import * as cloud from '../api/cloudClient'
import { getAllLocalProgress, getLocalProgress, putLocalProgress, deleteLocalProgress } from './progressStore'
import { trySync } from './syncEngine'
import type { LocalProgressEntry } from './db'
import { logPlayerEvent } from '../player/playerDebugLog'

function isNewer(a: { updatedAt: string }, b: { updatedAt: string } | undefined): boolean {
  return !b || a.updatedAt > b.updatedAt
}

/** Resolves the actual current progress for one book by comparing local
 * and cloud copies — whichever was captured more recently wins, same
 * last-write-wins rule the server uses. Works offline (falls back to
 * local-only if the cloud is unreachable) and self-heals a stuck pending
 * local write by re-triggering a sync attempt. */
export async function reconcileProgress(token: string | null, bookId: string): Promise<LocalProgressEntry | null> {
  // TEMPORARY diagnostic (see playerDebugLog.ts) — getLocalProgress was
  // previously unguarded here, so a hang/throw on the local read (the
  // long-background IDB zombie-connection theory) would just propagate
  // silently out of the whole function with nothing logged. Caught,
  // logged, and rethrown so this specific failure point is visible
  // without changing the actual fallback behavior below (there isn't a
  // safe fallback for a failed local read the way there is for a failed
  // cloud one — this book's progress genuinely can't be resolved).
  let local: LocalProgressEntry | undefined
  try {
    local = await getLocalProgress(bookId)
  } catch (err) {
    logPlayerEvent('progress:reconcile local-read FAILED', { bookId, err: String(err) })
    throw err
  }
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
    logPlayerEvent('progress:reconcile', { bookId, source: 'local', updatedAt: local.updatedAt })
    if (!local.synced) void trySync(token)
    return local
  }
  if (cloudAsLocal) {
    logPlayerEvent('progress:reconcile', { bookId, source: 'cloud', updatedAt: cloudAsLocal.updatedAt })
    await putLocalProgress(cloudAsLocal)
    return cloudAsLocal
  }
  logPlayerEvent('progress:reconcile', { bookId, source: 'none' })
  return null
}

/** Same idea as reconcileProgress, but for every book at once — used by
 * the Library's Continue Listening shelf. */
export async function reconcileAllProgress(token: string | null): Promise<LocalProgressEntry[]> {
  // TEMPORARY diagnostic (see playerDebugLog.ts) — same reasoning as
  // reconcileProgress above: getAllLocalProgress was unguarded here, so a
  // failure on it (this is what feeds the Library's In Progress shelf)
  // would reject this whole function with nothing logged to say why the
  // shelf went blank.
  // Cloud fetch kicked off immediately (not awaited yet) so it still runs
  // concurrently with the local read below, same as the Promise.all this
  // replaced — only the local read gets its own try/catch for logging.
  const cloudAllPromise = token ? cloud.fetchAllProgress(token).catch(() => []) : Promise.resolve([])
  let localAll: LocalProgressEntry[]
  try {
    localAll = await getAllLocalProgress()
  } catch (err) {
    logPlayerEvent('progress:reconcile-all local-read FAILED', { err: String(err) })
    throw err
  }
  const cloudAll = await cloudAllPromise

  const byBookId = new Map<string, LocalProgressEntry>()
  for (const local of localAll) byBookId.set(local.bookId, local)

  for (const entry of cloudAll) {
    // A single malformed cloud row (missing the fields IndexedDB's keyPath
    // or the Continue Listening sort depend on) shouldn't take down the
    // whole library fetch for every other book — skip just that row.
    if (!entry.book_id || !entry.updated_at) continue
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

  logPlayerEvent('progress:reconcile-all', {
    localCount: localAll.length,
    cloudCount: cloudAll.length,
    mergedCount: byBookId.size,
    hadUnsynced,
  })
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
