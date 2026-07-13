import { useCallback, useEffect, useState } from 'react'
import type { Chapter } from '../types'
import { getCachedAudioFilesForBook } from '../offline/audioFileStore'
import {
  DEFAULT_STORAGE_BUDGET_MB,
  deleteBookDownload,
  deleteChapterDownload,
  downloadChapter,
} from '../offline/downloadManager'
import { fetchSettings } from '../api/cloudClient'
import { useAuth } from '../auth/AuthContext'

/** Tracks which of a book's chapters are cached offline, and exposes
 * download/delete actions. Cached-ness is per underlying file
 * (sourceFileId), so downloading one M4B chapter marks all its siblings
 * cached too — see db.ts. */
export function useDownloads(bookId: string, chapters: Chapter[]) {
  const auth = useAuth()
  const [cachedFileIds, setCachedFileIds] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Set<string>>(new Set()) // sourceFileIds currently downloading

  const refresh = useCallback(async () => {
    const entries = await getCachedAudioFilesForBook(bookId)
    setCachedFileIds(new Set(entries.map((e) => e.sourceFileId)))
  }, [bookId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const getBudgetMb = useCallback(async (): Promise<number> => {
    if (!auth.token) return DEFAULT_STORAGE_BUDGET_MB
    try {
      const settings = await fetchSettings(auth.token)
      return settings.storage_budget_mb
    } catch {
      return DEFAULT_STORAGE_BUDGET_MB
    }
  }, [auth.token])

  const isCached = useCallback((chapter: Chapter) => cachedFileIds.has(chapter.sourceFileId), [cachedFileIds])
  const isPending = useCallback((chapter: Chapter) => pending.has(chapter.sourceFileId), [pending])

  const download = useCallback(
    async (chapter: Chapter) => {
      setPending((p) => new Set(p).add(chapter.sourceFileId))
      try {
        const budgetMb = await getBudgetMb()
        await downloadChapter(chapter, budgetMb)
        await refresh()
      } finally {
        setPending((p) => {
          const next = new Set(p)
          next.delete(chapter.sourceFileId)
          return next
        })
      }
    },
    [getBudgetMb, refresh],
  )

  const downloadAll = useCallback(async () => {
    const budgetMb = await getBudgetMb()
    for (const chapter of chapters) {
      if (cachedFileIds.has(chapter.sourceFileId)) continue
      setPending((p) => new Set(p).add(chapter.sourceFileId))
      try {
        await downloadChapter(chapter, budgetMb)
      } finally {
        setPending((p) => {
          const next = new Set(p)
          next.delete(chapter.sourceFileId)
          return next
        })
      }
    }
    await refresh()
  }, [chapters, cachedFileIds, getBudgetMb, refresh])

  const remove = useCallback(
    async (chapter: Chapter) => {
      await deleteChapterDownload(chapter)
      await refresh()
    },
    [refresh],
  )

  const removeAll = useCallback(async () => {
    await deleteBookDownload(bookId)
    await refresh()
  }, [bookId, refresh])

  return { isCached, isPending, download, downloadAll, remove, removeAll }
}
