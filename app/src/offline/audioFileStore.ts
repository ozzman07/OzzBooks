import { getDb, type CachedAudioFileEntry, type LegacyCachedAudioFileEntry } from './db'
import { getCachedBookDetail } from './bookDetailCacheStore'

// Where the actual audio bytes live — see CachedAudioFileEntry's doc
// comment in db.ts for why this isn't IndexedDB.
const AUDIO_CACHE_NAME = 'offline-audio-v1'

export function offlineAudioUrl(sourceFileId: string): string {
  return `/offline-audio/${encodeURIComponent(sourceFileId)}`
}

export async function getCachedAudioFile(sourceFileId: string): Promise<CachedAudioFileEntry | undefined> {
  return (await getDb()).get('audioFiles', sourceFileId)
}

export async function getCachedAudioFilesForBook(bookId: string): Promise<CachedAudioFileEntry[]> {
  return (await getDb()).getAllFromIndex('audioFiles', 'bookId', bookId)
}

export async function getAllCachedAudioFiles(): Promise<CachedAudioFileEntry[]> {
  return (await getDb()).getAll('audioFiles')
}

/** Writes the audio bytes into Cache Storage (not IndexedDB — see db.ts)
 * and the metadata into IndexedDB. mimeType is required here, not
 * optional/fallback-resolved later: resolving it once at write time means
 * the service worker's read path (offlineAudioRange.ts) never needs to
 * touch IndexedDB at all, which is the whole point of this split. */
export async function putCachedAudioFile(
  metadata: CachedAudioFileEntry,
  blob: Blob,
  mimeType: string,
): Promise<void> {
  const cache = await caches.open(AUDIO_CACHE_NAME)
  await cache.put(
    offlineAudioUrl(metadata.sourceFileId),
    new Response(blob, { headers: { 'Content-Type': mimeType, 'Content-Length': String(blob.size) } }),
  )
  await (await getDb()).put('audioFiles', metadata)
}

export async function deleteCachedAudioFile(sourceFileId: string): Promise<void> {
  const cache = await caches.open(AUDIO_CACHE_NAME)
  await cache.delete(offlineAudioUrl(sourceFileId))
  await (await getDb()).delete('audioFiles', sourceFileId)
}

export async function deleteCachedAudioFilesForBook(bookId: string): Promise<void> {
  const db = await getDb()
  const files = await db.getAllFromIndex('audioFiles', 'bookId', bookId)
  const cache = await caches.open(AUDIO_CACHE_NAME)
  await Promise.all(files.map((f) => cache.delete(offlineAudioUrl(f.sourceFileId))))
  const tx = db.transaction('audioFiles', 'readwrite')
  await Promise.all(files.map((f) => tx.store.delete(f.sourceFileId)))
  await tx.done
}

// Book.format is 'm4b' | 'mp3_folder' | 'epub' | 'cbz' (types.ts) — only the
// first two are ever audio. Used only for a legacy row with no Content-Type
// of its own to read back (see migrateLegacyAudioBlobIfNeeded below).
const FORMAT_MIME: Record<string, string> = {
  m4b: 'audio/mp4',
  mp3_folder: 'audio/mpeg',
}
const DEFAULT_MIME = 'audio/mp4' // this app's dominant/default audio format

/** A book downloaded before the Cache Storage migration has its blob sitting
 * directly in the IndexedDB row (the old CachedAudioFileEntry shape) — see
 * LegacyCachedAudioFileEntry's doc comment in db.ts. Called from
 * PlayerContext's resolveAudioSrc (the page context, which reliably reads
 * IndexedDB — only service-worker-side reads were ever in question) the
 * first time that book is played after updating: moves the blob into Cache
 * Storage and rewrites the row to the metadata-only shape. No-op if the
 * row is already in the new shape. Lazy/on-demand rather than a batch
 * migration, matching this codebase's existing "old rows keep their old
 * shape until touched" precedent (see CachedEpubFileEntry.lastReadAt). */
export async function migrateLegacyAudioBlobIfNeeded(entry: LegacyCachedAudioFileEntry): Promise<void> {
  if (!entry.blob) return
  const legacyBlob = entry.blob
  let mimeType = legacyBlob.type
  if (!mimeType) {
    const detail = await getCachedBookDetail(entry.bookId)
    mimeType = (detail?.book.format ? FORMAT_MIME[detail.book.format] : undefined) ?? DEFAULT_MIME
  }
  const { blob: _blob, ...metadata } = entry
  await putCachedAudioFile(metadata, legacyBlob, mimeType)
}

// Audio-only total — downloadManager.ts's own getTotalCachedBytes() sums
// this together with epub/comic totals for the real, format-wide figure.
// Named distinctly (not just getTotalCachedBytes) so nothing accidentally
// imports the audio-only version expecting the whole-app total.
export async function getAudioTotalCachedBytes(): Promise<number> {
  const all = await getAllCachedAudioFiles()
  return all.reduce((sum, f) => sum + f.sizeBytes, 0)
}

export async function touchLastPlayed(sourceFileId: string, when: string): Promise<void> {
  const db = await getDb()
  const entry = await db.get('audioFiles', sourceFileId)
  if (entry) await db.put('audioFiles', { ...entry, lastPlayedAt: when })
}
