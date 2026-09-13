import type { LegacyCachedAudioFileEntry } from './db'
import { getCachedBookDetail } from './bookDetailCacheStore'
import { hasAudioChunk, putAudioChunk, putAudioManifest } from './audioChunkStore'
import { getTransferProgress, putCachedAudioFile, putTransferProgress, deleteTransferProgress } from './audioFileStore'
import { DOWNLOAD_CHUNK_BYTES as CHUNK_SIZE, resolveAudioMimeType } from './downloadManager'

// A legacy blob predates Content-Type capture entirely, so it's never got
// one of its own beyond whatever the browser may have inferred (usually
// nothing, per fetchInChunks's history) — falls back to the book's format
// the same way a fresh download would if its server response omitted
// Content-Type (see resolveAudioMimeType in downloadManager.ts).
async function resolveLegacyMimeType(blob: Blob, bookId: string): Promise<string> {
  if (blob.type) return blob.type
  const detail = await getCachedBookDetail(bookId)
  return resolveAudioMimeType(detail?.book.format, null)
}

/** A book downloaded before the chunked-storage redesign has its blob
 * sitting directly in the IndexedDB row (see LegacyCachedAudioFileEntry's
 * doc comment in db.ts). Called from PlayerContext's resolveAudioSrc (page
 * context — reliably reads IndexedDB; only service-worker-side reads were
 * ever in question) the first time that book is played after updating:
 * moves the blob into Cache Storage, one ~8MB slice at a time via
 * legacyBlob.slice() (lazy — doesn't copy until read), and rewrites the
 * row to the metadata-only shape. No-op if already migrated.
 *
 * Resumable: a dedicated progress row tracks chunksWritten, and a crash
 * partway through picks back up near where it left off on the next call
 * rather than restarting (and potentially crashing again on) the same
 * ~800MB read from scratch — this is exactly what went wrong in the
 * reverted attempt that read+wrote the whole legacy blob in one shot. */
export async function migrateLegacyAudioIfNeeded(entry: LegacyCachedAudioFileEntry): Promise<void> {
  if (!entry.blob) return
  const legacyBlob = entry.blob
  const totalSize = legacyBlob.size
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE)
  const mimeType = await resolveLegacyMimeType(legacyBlob, entry.bookId)

  const progress = await getTransferProgress(entry.sourceFileId)
  let resumeFrom = progress?.chunksWritten ?? 0
  // Defensive: don't just trust the counter if a chunk write succeeded but
  // the progress-row write that should follow it didn't (or vice versa) —
  // walk back to the last chunk that's actually present.
  while (resumeFrom > 0 && !(await hasAudioChunk(entry.sourceFileId, resumeFrom - 1))) resumeFrom--

  for (let i = resumeFrom; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE, totalSize)
    await putAudioChunk(entry.sourceFileId, i, legacyBlob.slice(start, end))
    await putTransferProgress({
      sourceFileId: entry.sourceFileId,
      bookId: entry.bookId,
      chunksWritten: i + 1,
      chunkCount,
      totalSize,
      mimeType,
    })
  }

  await putAudioManifest(entry.sourceFileId, { totalSize, chunkSize: CHUNK_SIZE, chunkCount, mimeType })
  const { blob: _blob, ...metadata } = entry
  await putCachedAudioFile({ ...metadata, chunkCount })
  await deleteTransferProgress(entry.sourceFileId)
}
