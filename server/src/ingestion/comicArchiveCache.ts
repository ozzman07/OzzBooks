import { readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { isImageFile, naturalCompare } from './comic.js'

interface CachedArchive {
  filePath: string
  /** Natural-sorted image entry names — index N here is page N. */
  entryNames: string[]
  zip: JSZip
}

// A reading session only ever touches one or two books at a time — this
// just bounds memory growth across many different books read over a long
// server uptime, not a real working-set limit. Plain insertion-order Map
// used as an LRU: a hit re-inserts the entry (moving it to the end),
// eviction drops from the front.
export const MAX_CACHED_ARCHIVES = 8
const cache = new Map<string, CachedArchive>()

async function loadArchive(filePath: string): Promise<CachedArchive> {
  const buffer = await readFile(filePath)
  const zip = await JSZip.loadAsync(buffer)
  const entryNames = Object.values(zip.files)
    .filter((f) => !f.dir && isImageFile(f.name))
    .map((f) => f.name)
    .sort(naturalCompare)
  return { filePath, entryNames, zip }
}

/**
 * The "already-opened archive -> sorted entry list" cache this route needs
 * to avoid re-reading and re-sorting the zip central directory on every
 * single page request during a reading session (some issues run 30+ pages,
 * flipped through in seconds). Keyed by book id; a stale entry whose
 * filePath no longer matches the book's current file_path (a relink moved
 * it) is transparently reloaded rather than served — self-healing, no
 * separate invalidation call needed for the one real case (a relink) that
 * changes a comic's identity out from under an open cache entry.
 */
async function getArchive(bookId: string, filePath: string): Promise<CachedArchive> {
  const cached = cache.get(bookId)
  if (cached && cached.filePath === filePath) {
    cache.delete(bookId)
    cache.set(bookId, cached)
    return cached
  }

  const fresh = await loadArchive(filePath)
  cache.set(bookId, fresh)
  if (cache.size > MAX_CACHED_ARCHIVES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) cache.delete(oldestKey)
  }
  return fresh
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
 * for an out-of-range index (caller responds 404) rather than throwing. */
export async function getComicPage(bookId: string, filePath: string, pageIndex: number): Promise<ComicPage | null> {
  const archive = await getArchive(bookId, filePath)
  const entryName = archive.entryNames[pageIndex]
  if (entryName === undefined) return null

  const buffer = await archive.zip.files[entryName].async('nodebuffer')
  const ext = path.extname(entryName).toLowerCase()
  return { buffer, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' }
}
