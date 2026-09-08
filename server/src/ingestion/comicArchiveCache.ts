import path from 'node:path'
import * as yauzl from 'yauzl'
import { isImageFile, naturalCompare } from './comic.js'

interface CachedArchive {
  filePath: string
  /** Natural-sorted image entries — index N here is page N. Kept as full
   * yauzl Entry objects (not just names) since openReadStreamPromise needs
   * the entry itself to seek straight to its data, not a name lookup. */
  entries: yauzl.Entry[]
  zipfile: yauzl.ZipFile
}

// A reading session only ever touches one or two books at a time — this
// just bounds memory growth across many different books read over a long
// server uptime, not a real working-set limit. Plain insertion-order Map
// used as an LRU: a hit re-inserts the entry (moving it to the end),
// eviction drops from the front.
export const MAX_CACHED_ARCHIVES = 8
const cache = new Map<string, CachedArchive>()

// De-dupes concurrent loads of the same not-yet-cached book — opening a
// comic fires off requests for the first few pages together (prefetch),
// and without this every one of them would independently open and index
// the same archive before any single load finishes populating the cache.
const inFlightLoads = new Map<string, Promise<CachedArchive>>()

/**
 * Opens the archive and reads only its central directory (entry names,
 * sizes, offsets) — not the actual page image data. This is what makes a
 * multi-hundred-MB-to-several-GB comic fast to open: previously this read
 * the *entire* file into memory (a real, observed problem — a 900MB
 * archive over network-mounted storage was slow enough to blow past the
 * reader's load timeout even for the very first page). autoClose: false
 * keeps the underlying file descriptor open across the many subsequent
 * per-page reads this cache entry will serve; evictArchive below is
 * responsible for closing it.
 */
async function loadArchive(filePath: string): Promise<CachedArchive> {
  const zipfile = await yauzl.openPromise(filePath, { lazyEntries: true, autoClose: false })
  const entries: yauzl.Entry[] = []
  for await (const entry of zipfile.eachEntry()) {
    if (!entry.fileName.endsWith('/') && isImageFile(entry.fileName)) entries.push(entry)
  }
  entries.sort((a, b) => naturalCompare(a.fileName, b.fileName))
  return { filePath, entries, zipfile }
}

function evictArchive(archive: CachedArchive): void {
  archive.zipfile.close()
}

/**
 * The "already-opened archive -> sorted entry list" cache this route needs
 * to avoid re-opening and re-indexing the zip on every single page request
 * during a reading session (some issues run 30+ pages, flipped through in
 * seconds). Keyed by book id; a stale entry whose filePath no longer
 * matches the book's current file_path (a relink moved it) is transparently
 * reloaded rather than served — self-healing, no separate invalidation call
 * needed for the one real case (a relink) that changes a comic's identity
 * out from under an open cache entry.
 */
async function getArchive(bookId: string, filePath: string): Promise<CachedArchive> {
  const cached = cache.get(bookId)
  if (cached && cached.filePath === filePath) {
    cache.delete(bookId)
    cache.set(bookId, cached)
    return cached
  }
  if (cached) evictArchive(cached) // relink — the old handle is for a different file now

  const existingLoad = inFlightLoads.get(bookId)
  if (existingLoad) return existingLoad

  const loadPromise = (async () => {
    try {
      const fresh = await loadArchive(filePath)
      cache.set(bookId, fresh)
      if (cache.size > MAX_CACHED_ARCHIVES) {
        const oldestKey = cache.keys().next().value
        if (oldestKey !== undefined) {
          const oldest = cache.get(oldestKey)
          cache.delete(oldestKey)
          if (oldest) evictArchive(oldest)
        }
      }
      return fresh
    } finally {
      inFlightLoads.delete(bookId)
    }
  })()
  inFlightLoads.set(bookId, loadPromise)
  return loadPromise
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export interface ComicPage {
  buffer: Buffer
  contentType: string
}

/** Zero-indexed — page 0 is the first (cover) page, same indexing as
 * page_count and the archive's own natural-sorted entry list. Returns null
 * for an out-of-range index (caller responds 404) rather than throwing.
 * Only this one requested page's compressed bytes are read and decompressed
 * — the rest of the archive's page images are never touched. */
export async function getComicPage(bookId: string, filePath: string, pageIndex: number): Promise<ComicPage | null> {
  const archive = await getArchive(bookId, filePath)
  const entry = archive.entries[pageIndex]
  if (entry === undefined) return null

  const stream = await archive.zipfile.openReadStreamPromise(entry)
  const buffer = await streamToBuffer(stream)
  const ext = path.extname(entry.fileName).toLowerCase()
  return { buffer, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' }
}
