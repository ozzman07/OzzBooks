import type { Chapter } from '../types'
import { fetchEpubBytes, comicPageUrl } from '../api/client'
import {
  deleteCachedAudioFile,
  deleteCachedAudioFilesForBook,
  getAllCachedAudioFiles,
  getAudioTotalCachedBytes,
  getCachedAudioFile,
  putCachedAudioFile,
} from './audioFileStore'
import { deleteCachedEpubFile, getAllCachedEpubFiles, getCachedEpubFile, putCachedEpubFile } from './epubFileStore'
import {
  deleteCachedComicPagesForBook,
  deleteComicDownload as deleteComicDownloadRecord,
  getAllCachedComicPages,
  getAllComicDownloads,
  getCachedComicPage,
  getCachedComicPagesForBook,
  getComicDownload,
  putCachedComicPage,
  putComicDownload,
} from './comicPageStore'

export const DEFAULT_STORAGE_BUDGET_MB = 2000

export async function isChapterCached(chapter: Chapter): Promise<boolean> {
  return (await getCachedAudioFile(chapter.sourceFileId)) !== undefined
}

/**
 * Format-wide total — audio + epub + comic pages together. Used both by
 * ensureBudget below and by Settings.tsx's storage display. Deliberately a
 * function, not a cached value: called right before every download
 * decision, and IndexedDB reads here are fast enough that caching this
 * would just be a staleness risk for no real benefit.
 */
export async function getTotalCachedBytes(): Promise<number> {
  const [audioBytes, epubs, comicPages] = await Promise.all([
    getAudioTotalCachedBytes(),
    getAllCachedEpubFiles(),
    getAllCachedComicPages(),
  ])
  const epubBytes = epubs.reduce((sum, e) => sum + e.sizeBytes, 0)
  const comicBytes = comicPages.reduce((sum, p) => sum + p.sizeBytes, 0)
  return audioBytes + epubBytes + comicBytes
}

/** Same breakdown as getTotalCachedBytes, but split by content type — what
 * Settings.tsx's storage section shows so "why did my audiobooks get
 * evicted" has an answerable "comics used the budget" instead of one
 * opaque total (per Ozzbooks_Addendum_Comics' Offline download experience
 * section). */
export async function getCachedBytesByContentType(): Promise<{ audio: number; ebook: number; comics: number }> {
  const [audio, epubs, comicPages] = await Promise.all([
    getAudioTotalCachedBytes(),
    getAllCachedEpubFiles(),
    getAllCachedComicPages(),
  ])
  return {
    audio,
    ebook: epubs.reduce((sum, e) => sum + e.sizeBytes, 0),
    comics: comicPages.reduce((sum, p) => sum + p.sizeBytes, 0),
  }
}

interface EvictionCandidate {
  bytes: number
  lastUsedAt: string
  evict: () => Promise<void>
}

// One candidate per evictable *unit* — an individual audio file, an epub
// (already whole-book, one file), or a comic's entire set of cached pages
// together (never partially, per CachedComicDownloadEntry's doc comment
// in db.ts). Building this fresh on every eviction pass rather than
// caching it — see getTotalCachedBytes' own reasoning above.
async function collectEvictionCandidates(): Promise<EvictionCandidate[]> {
  const [audioFiles, epubFiles, comicDownloads] = await Promise.all([
    getAllCachedAudioFiles(),
    getAllCachedEpubFiles(),
    getAllComicDownloads(),
  ])

  const candidates: EvictionCandidate[] = []

  for (const a of audioFiles) {
    candidates.push({
      bytes: a.sizeBytes,
      lastUsedAt: a.lastPlayedAt,
      evict: () => deleteCachedAudioFile(a.sourceFileId),
    })
  }

  for (const e of epubFiles) {
    candidates.push({
      // See CachedEpubFileEntry's doc comment — a pre-existing entry from
      // before lastReadAt existed falls back to downloadedAt.
      bytes: e.sizeBytes,
      lastUsedAt: e.lastReadAt ?? e.downloadedAt,
      evict: () => deleteCachedEpubFile(e.bookId),
    })
  }

  for (const c of comicDownloads) {
    const pages = await getCachedComicPagesForBook(c.bookId)
    const bytes = pages.reduce((sum, p) => sum + p.sizeBytes, 0)
    if (bytes === 0) continue // metadata record with nothing actually cached — nothing to evict
    candidates.push({
      bytes,
      lastUsedAt: c.lastReadAt,
      evict: async () => {
        await deleteCachedComicPagesForBook(c.bookId)
        await deleteComicDownloadRecord(c.bookId)
      },
    })
  }

  return candidates
}

/** Evicts the globally least-recently-used cached item — audio file, epub,
 * or whole comic issue, whichever is oldest, regardless of format — until
 * there's room for `incomingBytes` within `budgetBytes`. The primary
 * automatic storage mechanism per Claude.md, generalized across all three
 * formats (previously audio-only; see Ozzbooks_Addendum_Comics' Offline
 * download experience section for why epub silently having no budget
 * check at all was a real risk once comics could be tens to over a
 * hundred MB per issue). */
async function ensureBudget(incomingBytes: number, budgetBytes: number): Promise<void> {
  let used = await getTotalCachedBytes()
  if (used + incomingBytes <= budgetBytes) return

  const candidates = await collectEvictionCandidates()
  candidates.sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt)) // oldest first

  for (const candidate of candidates) {
    if (used + incomingBytes <= budgetBytes) break
    await candidate.evict()
    used -= candidate.bytes
  }
}

// --- Audio -------------------------------------------------------------

/** Downloads a chapter's underlying audio file into IndexedDB for offline
 * playback. A no-op if already cached — including when a *different*
 * chapter of the same M4B already cached the same underlying file.
 * Evicts older cached items first (any format) if needed to stay within
 * the storage budget. */
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

// --- Ebook ---------------------------------------------------------------

/** Downloads an epub's full bytes into IndexedDB. Previously wrote
 * straight to epubFileStore with no budget check at all (see the
 * addendum's Offline download experience finding) — now goes through the
 * same ensureBudget every other format does. */
export async function downloadEpubFile(bookId: string, budgetMb: number = DEFAULT_STORAGE_BUDGET_MB): Promise<void> {
  if (await getCachedEpubFile(bookId)) return

  const bytes = await fetchEpubBytes(bookId)
  await ensureBudget(bytes.byteLength, budgetMb * 1024 * 1024)

  const now = new Date().toISOString()
  await putCachedEpubFile({
    bookId,
    blob: new Blob([bytes]),
    sizeBytes: bytes.byteLength,
    downloadedAt: now,
    lastReadAt: now,
  })
}

export async function deleteEpubDownload(bookId: string): Promise<void> {
  await deleteCachedEpubFile(bookId)
}

// --- Comics ----------------------------------------------------------------

/** Downloads a single comic page. Used both by the explicit "download
 * whole issue" flow below and by ComicReader's opportunistic pre-fetch —
 * either way, it goes through the same budget check as everything else,
 * and ensures a comicDownloads metadata record exists (created with
 * complete: false if this is the first page ever cached for this book) so
 * eviction has a lastReadAt to sort by even before a full download ever
 * happens. A no-op if this exact page is already cached. */
export async function downloadComicPage(
  bookId: string,
  pageIndex: number,
  pageCount: number,
  budgetMb: number = DEFAULT_STORAGE_BUDGET_MB,
): Promise<void> {
  if (await getCachedComicPage(bookId, pageIndex)) return

  const res = await fetch(comicPageUrl(bookId, pageIndex))
  if (!res.ok) throw new Error(`Failed to download comic page: ${res.status}`)
  const blob = await res.blob()

  await ensureBudget(blob.size, budgetMb * 1024 * 1024)

  const now = new Date().toISOString()
  await putCachedComicPage({
    key: `${bookId}:${pageIndex}`,
    bookId,
    pageIndex,
    blob,
    sizeBytes: blob.size,
    downloadedAt: now,
  })

  const existing = await getComicDownload(bookId)
  if (!existing) {
    await putComicDownload({ bookId, pageCount, complete: false, startedAt: now, lastReadAt: now })
  }
}

/** Downloads every page of a comic — the "download whole book" action.
 * Refreshes progress after each page (not just once at the end), same
 * incremental pattern useDownloads.downloadAll() already uses per audio
 * chapter, so a badge can show real progress instead of a single long
 * pause. Completion is set explicitly and only here, once every page has
 * genuinely landed — see CachedComicDownloadEntry's doc comment for why
 * this can't be inferred from a blob count after an interrupted
 * download. */
export async function downloadComic(
  bookId: string,
  pageCount: number,
  budgetMb: number = DEFAULT_STORAGE_BUDGET_MB,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < pageCount; i++) {
    await downloadComicPage(bookId, i, pageCount, budgetMb)
    onProgress?.(i + 1, pageCount)
  }
  const now = new Date().toISOString()
  const existing = await getComicDownload(bookId)
  await putComicDownload({ bookId, pageCount, complete: true, startedAt: existing?.startedAt ?? now, lastReadAt: now })
}

export async function deleteComicDownload(bookId: string): Promise<void> {
  await deleteCachedComicPagesForBook(bookId)
  await deleteComicDownloadRecord(bookId)
}
