import * as cloud from '../api/cloudClient'
import { getUnsyncedProgress, markSyncedIfUnchanged, putLocalProgress } from './progressStore'
import type { LocalProgressEntry } from './db'

const MIN_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000

let backoffMs = MIN_BACKOFF_MS
let retryTimer: ReturnType<typeof setTimeout> | null = null
let listenersInstalled = false

function scheduleRetry(token: string) {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void trySync(token)
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

function installReconnectListener(token: string) {
  if (listenersInstalled) return
  listenersInstalled = true
  window.addEventListener('online', () => void trySync(token))
}

async function syncOne(token: string, entry: LocalProgressEntry): Promise<boolean> {
  const result = await cloud.putProgress(token, entry.bookId, {
    position: entry.position,
    chapterId: entry.chapterId,
    updatedAt: entry.updatedAt,
  })

  if (result.updated_at === entry.updatedAt) {
    // Our write won the last-write-wins comparison server-side.
    await markSyncedIfUnchanged(entry.bookId, entry.updatedAt)
  } else {
    // A newer write (from another device) already won — adopt it locally
    // instead of leaving our stale value marked pending forever.
    await putLocalProgress({
      bookId: entry.bookId,
      chapterId: result.chapter_id ?? entry.chapterId,
      position: result.position,
      updatedAt: result.updated_at,
      synced: true,
    })
  }
  return true
}

/** Attempts to push every unsynced local progress row to the cloud.
 * Best-effort: network failures are swallowed and retried with backoff,
 * matching "queued to sync whenever connectivity is available" from
 * Claude.md — this is the actual queue, not a direct fire-and-forget call. */
export async function trySync(token: string | null): Promise<void> {
  if (!token) return
  installReconnectListener(token)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    scheduleRetry(token)
    return
  }

  const pending = await getUnsyncedProgress()
  if (pending.length === 0) {
    backoffMs = MIN_BACKOFF_MS
    return
  }

  let allSucceeded = true
  for (const entry of pending) {
    try {
      await syncOne(token, entry)
    } catch {
      allSucceeded = false
    }
  }

  if (allSucceeded) {
    backoffMs = MIN_BACKOFF_MS
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  } else {
    scheduleRetry(token)
  }
}

/** Records a position locally (always succeeds, no network dependency)
 * and kicks off a sync attempt. */
export async function recordProgress(
  token: string | null,
  bookId: string,
  chapterId: string,
  position: LocalProgressEntry['position'],
  updatedAt: string,
): Promise<void> {
  await putLocalProgress({ bookId, chapterId, position, updatedAt, synced: false })
  void trySync(token)
}
