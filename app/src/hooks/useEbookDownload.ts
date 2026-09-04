import { useCallback, useEffect, useState } from 'react'
import { getCachedEpubFile } from '../offline/epubFileStore'
import { DEFAULT_STORAGE_BUDGET_MB, deleteEpubDownload, downloadEpubFile } from '../offline/downloadManager'
import { fetchSettings } from '../api/cloudClient'
import { useAuth } from '../auth/AuthContext'

/** Tracks whether a single epub book is cached offline, and exposes
 * download/remove actions. Unlike audio's per-chapter useDownloads, an
 * epub is one file with no partial state — cached or not. `bookId` is
 * the epub row's own id (not an audiobook companion's), same id
 * fetchEpubBytes/EbookReader use. Downloads go through downloadManager's
 * generalized storage budget (previously wrote straight to epubFileStore
 * with no budget check at all — see Ozzbooks_Addendum_Comics' Offline
 * download experience finding). */
export function useEbookDownload(bookId: string | undefined) {
  const auth = useAuth()
  const [cached, setCached] = useState(false)
  const [pending, setPending] = useState(false)

  const refresh = useCallback(async () => {
    if (!bookId) {
      setCached(false)
      return
    }
    setCached((await getCachedEpubFile(bookId)) !== undefined)
  }, [bookId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const download = useCallback(async () => {
    if (!bookId) return
    setPending(true)
    try {
      let budgetMb = DEFAULT_STORAGE_BUDGET_MB
      if (auth.token) {
        try {
          budgetMb = (await fetchSettings(auth.token)).storage_budget_mb
        } catch {
          // fall back to the default — same "don't block a download over a
          // settings fetch hiccup" reasoning useDownloads.ts already uses
        }
      }
      await downloadEpubFile(bookId, budgetMb)
      await refresh()
    } finally {
      setPending(false)
    }
  }, [bookId, auth.token, refresh])

  const remove = useCallback(async () => {
    if (!bookId) return
    await deleteEpubDownload(bookId)
    await refresh()
  }, [bookId, refresh])

  return { cached, pending, download, remove }
}
