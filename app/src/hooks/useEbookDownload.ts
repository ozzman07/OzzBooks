import { useCallback, useEffect, useState } from 'react'
import { fetchEpubBytes } from '../api/client'
import { getCachedEpubFile, putCachedEpubFile, deleteCachedEpubFile } from '../offline/epubFileStore'

/** Tracks whether a single epub book is cached offline, and exposes
 * download/remove actions. Unlike audio's per-chapter useDownloads, an
 * epub is one file with no partial state — cached or not. `bookId` is
 * the epub row's own id (not an audiobook companion's), same id
 * fetchEpubBytes/EbookReader use. */
export function useEbookDownload(bookId: string | undefined) {
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
      const bytes = await fetchEpubBytes(bookId)
      await putCachedEpubFile({
        bookId,
        blob: new Blob([bytes]),
        sizeBytes: bytes.byteLength,
        downloadedAt: new Date().toISOString(),
      })
      await refresh()
    } finally {
      setPending(false)
    }
  }, [bookId, refresh])

  const remove = useCallback(async () => {
    if (!bookId) return
    await deleteCachedEpubFile(bookId)
    await refresh()
  }, [bookId, refresh])

  return { cached, pending, download, remove }
}
