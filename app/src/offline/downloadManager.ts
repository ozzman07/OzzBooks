import type { Chapter } from '../types'
import {
  deleteCachedAudioFile,
  deleteCachedAudioFilesForBook,
  getAllCachedAudioFiles,
  getCachedAudioFile,
  getTotalCachedBytes,
  putCachedAudioFile,
} from './audioFileStore'

export const DEFAULT_STORAGE_BUDGET_MB = 2000

export async function isChapterCached(chapter: Chapter): Promise<boolean> {
  return (await getCachedAudioFile(chapter.sourceFileId)) !== undefined
}

/** Evicts least-recently-played cached audio (across all books) until
 * there's room for `incomingBytes` within `budgetBytes` — the primary
 * automatic storage mechanism per Claude.md, keyed by last_played_at. */
async function ensureBudget(incomingBytes: number, budgetBytes: number): Promise<void> {
  let used = await getTotalCachedBytes()
  if (used + incomingBytes <= budgetBytes) return

  const all = await getAllCachedAudioFiles()
  all.sort((a, b) => a.lastPlayedAt.localeCompare(b.lastPlayedAt)) // oldest first

  for (const entry of all) {
    if (used + incomingBytes <= budgetBytes) break
    await deleteCachedAudioFile(entry.sourceFileId)
    used -= entry.sizeBytes
  }
}

/** Downloads a chapter's underlying audio file into IndexedDB for offline
 * playback. A no-op if already cached — including when a *different*
 * chapter of the same M4B already cached the same underlying file.
 * Evicts older audio first if needed to stay within the storage budget. */
export async function downloadChapter(chapter: Chapter, budgetMb: number = DEFAULT_STORAGE_BUDGET_MB): Promise<void> {
  if (await isChapterCached(chapter)) return

  const res = await fetch(chapter.audioUrl)
  if (!res.ok) throw new Error(`Failed to download chapter: ${res.status}`)
  const blob = await res.blob()

  await ensureBudget(blob.size, budgetMb * 1024 * 1024)

  const now = new Date().toISOString()
  await putCachedAudioFile({
    sourceFileId: chapter.sourceFileId,
    bookId: chapter.bookId,
    blob,
    sizeBytes: blob.size,
    downloadedAt: now,
    lastPlayedAt: now,
  })
}

export async function downloadBook(
  chapters: Chapter[],
  budgetMb: number = DEFAULT_STORAGE_BUDGET_MB,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < chapters.length; i++) {
    await downloadChapter(chapters[i], budgetMb)
    onProgress?.(i + 1, chapters.length)
  }
}

export async function deleteChapterDownload(chapter: Chapter): Promise<void> {
  await deleteCachedAudioFile(chapter.sourceFileId)
}

export async function deleteBookDownload(bookId: string): Promise<void> {
  await deleteCachedAudioFilesForBook(bookId)
}
