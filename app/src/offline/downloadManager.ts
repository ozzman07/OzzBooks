import type { Book, Chapter } from '../types'
import { fetchEpubBytes, comicPageUrl } from '../api/client'
import {
  deleteCachedAudioFile,
  deleteCachedAudioFilesForBook,
  getAllCachedAudioFiles,
  getAudioTotalCachedBytes,
  getCachedAudioFile,
  getTransferProgress,
  putCachedAudioFile,
  putTransferProgress,
  deleteTransferProgress,
} from './audioFileStore'
import { hasAudioChunk, putAudioChunk, putAudioManifest } from './audioChunkStore'
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

// A single fetch().blob() over a whole multi-hundred-MB audiobook file
// reliably fails on iPad/iPhone Safari with a generic "Load failed" —
// observed in practice on a 660 MB m4b — independent of network quality.
// Fetching it as a sequence of small Range requests instead keeps both
// the peak memory footprint and the blast radius of any one dropped
// connection small (a failed chunk gets retried, not the whole file).
export const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const CHUNK_RETRY_ATTEMPTS = 3

interface RangeChunk {
  blob: Blob
  status: number
  contentRange: string | null
  contentType: string | null
}

// Fetches AND fully reads one chunk's body — a dropped connection can
// fail either half (getting a response at all, or streaming its body to
// completion once headers already arrived), and both need to be inside
// the same retried unit. An earlier version only wrapped the initial
// fetch() call, so a mid-body disconnect (observed in production: the
// first four 8 MB chunks of a 660 MB file succeeded, then the fifth's
// connection dropped partway through res.blob()) sailed straight past
// the retry logic and failed the whole download.
async function fetchRangeChunk(url: string, start: number, end: number): Promise<RangeChunk> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`)
  const blob = await res.blob()
  return {
    blob,
    status: res.status,
    contentRange: res.headers.get('content-range'),
    contentType: res.headers.get('content-type'),
  }
}

async function fetchRangeWithRetry(url: string, start: number, end: number): Promise<RangeChunk> {
  let lastErr: unknown
  for (let attempt = 0; attempt < CHUNK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetchRangeChunk(url, start, end)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

// Book.format is 'm4b' | 'mp3_folder' | 'epub' | 'cbz' (types.ts) — only the
// first two are ever audio. Used as the fallback when a download/legacy
// blob has no Content-Type/blob.type of its own to go on (the synthetic
// /offline-audio/<id> URL the service worker serves this through has no
// file extension to sniff a type from — see offlineAudioRange.ts).
const FORMAT_MIME: Record<string, string> = {
  m4b: 'audio/mp4',
  mp3_folder: 'audio/mpeg',
}
const DEFAULT_MIME = 'audio/mp4' // this app's dominant/default audio format

export function resolveAudioMimeType(format: Book['format'] | undefined, explicit: string | null | undefined): string {
  if (explicit) return explicit
  return (format ? FORMAT_MIME[format] : undefined) ?? DEFAULT_MIME
}

/**
 * Fetches a URL's full content in small Range-requested chunks, writing
 * each directly into Cache Storage as it arrives (audioChunkStore.ts)
 * instead of concatenating into one Blob — a single ~800MB+ Blob is
 * exactly the shape of operation that crashed the phone in two prior,
 * reverted attempts (a giant Blob URL for playback, and a whole-file
 * read/write during a storage migration). Resumes from any existing
 * transfer progress instead of always starting at chunk 0, so an
 * interrupted download doesn't restart — and potentially fail again on —
 * the same work from scratch. Falls back to treating the response as the
 * whole file if the server doesn't honor Range (status 200 instead of
 * 206) — every route this calls today does support Range, so this is a
 * rarely-exercised defensive path; even then, the single received Blob is
 * sliced into chunk-sized pieces before writing, never written as one
 * giant cache entry.
 */
async function fetchInChunks(
  sourceFileId: string,
  bookId: string,
  url: string,
  format: Book['format'] | undefined,
  budgetBytes: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ totalSize: number; chunkCount: number; mimeType: string }> {
  const progress = await getTransferProgress(sourceFileId)
  let resumeFrom = progress?.chunksWritten ?? 0
  // Defensive: don't just trust the counter if a chunk write succeeded but
  // the progress-row write that should follow it didn't (or vice versa) —
  // walk back to the last chunk that's actually present.
  while (resumeFrom > 0 && !(await hasAudioChunk(sourceFileId, resumeFrom - 1))) resumeFrom--

  let totalSize: number
  let mimeType: string
  let chunkCount: number

  if (progress) {
    // A resumed transfer already passed this check before its first chunk
    // was ever written — no need to repeat it (and the total is already
    // known, no need to re-probe for it either).
    ;({ totalSize, mimeType, chunkCount } = progress)
  } else {
    const first = await fetchRangeWithRetry(url, 0, DOWNLOAD_CHUNK_BYTES - 1)
    if (first.status === 200) {
      // Server ignored Range — the whole file arrived in one response.
      // Slice it into chunk-sized pieces before writing (blob.slice() is
      // lazy) rather than ever writing it as one giant cache entry.
      totalSize = first.blob.size
      mimeType = resolveAudioMimeType(format, first.contentType)
      chunkCount = Math.ceil(totalSize / DOWNLOAD_CHUNK_BYTES)
      await ensureBudget(totalSize, budgetBytes)
      for (let i = 0; i < chunkCount; i++) {
        const start = i * DOWNLOAD_CHUNK_BYTES
        const end = Math.min(start + DOWNLOAD_CHUNK_BYTES, totalSize)
        await putAudioChunk(sourceFileId, i, first.blob.slice(start, end))
        await putTransferProgress({ sourceFileId, bookId, chunksWritten: i + 1, chunkCount, totalSize, mimeType })
        onProgress?.(end, totalSize)
      }
      return { totalSize, chunkCount, mimeType }
    }
    if (first.status !== 206) {
      throw new Error(`Failed to download: unexpected status ${first.status}`)
    }
    totalSize = first.contentRange ? Number(first.contentRange.split('/')[1]) : NaN
    if (!Number.isFinite(totalSize)) {
      throw new Error('Failed to download: server returned a partial response with no usable Content-Range')
    }
    mimeType = resolveAudioMimeType(format, first.contentType)
    chunkCount = Math.ceil(totalSize / DOWNLOAD_CHUNK_BYTES)
    await ensureBudget(totalSize, budgetBytes)
    await putAudioChunk(sourceFileId, 0, first.blob)
    await putTransferProgress({ sourceFileId, bookId, chunksWritten: 1, chunkCount, totalSize, mimeType })
    onProgress?.(first.blob.size, totalSize)
    resumeFrom = 1
  }

  for (let i = resumeFrom; i < chunkCount; i++) {
    const start = i * DOWNLOAD_CHUNK_BYTES
    const end = Math.min(start + DOWNLOAD_CHUNK_BYTES, totalSize) - 1
    const chunk = await fetchRangeWithRetry(url, start, end)
    await putAudioChunk(sourceFileId, i, chunk.blob)
    await putTransferProgress({ sourceFileId, bookId, chunksWritten: i + 1, chunkCount, totalSize, mimeType })
    onProgress?.(end + 1, totalSize)
  }

  return { totalSize, chunkCount, mimeType }
}

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
  // A single item bigger than the whole budget can never fit no matter what
  // gets evicted — checked before touching anything else already cached, so
  // a too-large download fails cleanly instead of silently wiping every
  // other offline download first and still not having room.
  if (incomingBytes > budgetBytes) {
    const mb = (n: number) => Math.ceil(n / (1024 * 1024))
    throw new Error(
      `This download (${mb(incomingBytes)} MB) is larger than your entire storage budget (${mb(budgetBytes)} MB). ` +
        `Increase the storage budget in Settings before downloading it.`,
    )
  }

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

/** Downloads a chapter's underlying audio file, chunk by chunk, into Cache
 * Storage for offline playback (see fetchInChunks). A no-op if already
 * cached — including when a *different* chapter of the same M4B already
 * cached the same underlying file. Evicts older cached items first (any
 * format) if needed to stay within the storage budget — checked as soon
 * as the file's size is known (inside fetchInChunks), before its first
 * chunk is ever written, so a rejected download doesn't leave partial
 * chunks needing cleanup. */
export async function downloadChapter(
  chapter: Chapter,
  format: Book['format'] | undefined,
  budgetMb: number = DEFAULT_STORAGE_BUDGET_MB,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  if (await isChapterCached(chapter)) return

  const { totalSize, chunkCount, mimeType } = await fetchInChunks(
    chapter.sourceFileId,
    chapter.bookId,
    chapter.audioUrl,
    format,
    budgetMb * 1024 * 1024,
    onProgress,
  )

  await putAudioManifest(chapter.sourceFileId, { totalSize, chunkSize: DOWNLOAD_CHUNK_BYTES, chunkCount, mimeType })

  const now = new Date().toISOString()
  await putCachedAudioFile({
    sourceFileId: chapter.sourceFileId,
    bookId: chapter.bookId,
    sizeBytes: totalSize,
    chunkCount,
    downloadedAt: now,
    lastPlayedAt: now,
  })
  await deleteTransferProgress(chapter.sourceFileId)
}

export async function downloadBook(
  chapters: Chapter[],
  format: Book['format'] | undefined,
  budgetMb: number = DEFAULT_STORAGE_BUDGET_MB,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < chapters.length; i++) {
    await downloadChapter(chapters[i], format, budgetMb)
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
