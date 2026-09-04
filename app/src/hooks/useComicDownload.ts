import { useCallback, useEffect, useState } from 'react'
import { getCachedComicPagesForBook, getComicDownload } from '../offline/comicPageStore'
import { DEFAULT_STORAGE_BUDGET_MB, deleteComicDownload, downloadComic } from '../offline/downloadManager'
import { fetchSettings } from '../api/cloudClient'
import { useAuth } from '../auth/AuthContext'

/** Tracks one comic's offline-download state and exposes download/remove
 * actions. Whole-issue downloads only (no per-page granularity) — closer
 * to useEbookDownload's "cached or not" shape than useDownloads' per-
 * chapter list, per Ozzbooks_Addendum_Comics' Offline download experience
 * section, even though under the hood it's fetching N page images.
 * `cachedCount`/`pageCount` drive an in-progress "X of Y downloaded"
 * display; `complete` is the explicit stored flag (see
 * CachedComicDownloadEntry in db.ts) distinguishing "fully downloaded"
 * from "died partway through," never inferred from the blob count alone. */
export function useComicDownload(bookId: string | undefined, pageCount: number | undefined) {
  const auth = useAuth()
  const [cachedCount, setCachedCount] = useState(0)
  const [complete, setComplete] = useState(false)
  const [pending, setPending] = useState(false)

  const refresh = useCallback(async () => {
    if (!bookId) {
      setCachedCount(0)
      setComplete(false)
      return
    }
    const [pages, record] = await Promise.all([getCachedComicPagesForBook(bookId), getComicDownload(bookId)])
    setCachedCount(pages.length)
    setComplete(record?.complete ?? false)
  }, [bookId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const download = useCallback(async () => {
    if (!bookId || !pageCount) return
    setPending(true)
    try {
      let budgetMb = DEFAULT_STORAGE_BUDGET_MB
      if (auth.token) {
        try {
          budgetMb = (await fetchSettings(auth.token)).storage_budget_mb
        } catch {
          // fall back to the default — same reasoning as useEbookDownload
        }
      }
      await downloadComic(bookId, pageCount, budgetMb, () => void refresh())
      await refresh()
    } finally {
      setPending(false)
    }
  }, [bookId, pageCount, auth.token, refresh])

  const remove = useCallback(async () => {
    if (!bookId) return
    await deleteComicDownload(bookId)
    await refresh()
  }, [bookId, refresh])

  return { cachedCount, complete, pending, download, remove }
}
