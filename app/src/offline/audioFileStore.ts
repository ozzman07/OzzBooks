import { getDb, type AudioTransferProgressEntry, type CachedAudioFileEntry } from './db'
import { deleteAudioFileChunks, deleteAudioManifest } from './audioChunkStore'

export async function getCachedAudioFile(sourceFileId: string): Promise<CachedAudioFileEntry | undefined> {
  return (await getDb()).get('audioFiles', sourceFileId)
}

export async function getCachedAudioFilesForBook(bookId: string): Promise<CachedAudioFileEntry[]> {
  return (await getDb()).getAllFromIndex('audioFiles', 'bookId', bookId)
}

export async function getAllCachedAudioFiles(): Promise<CachedAudioFileEntry[]> {
  return (await getDb()).getAll('audioFiles')
}

/** Metadata-only write — the audio bytes are written separately, chunk by
 * chunk, via audioChunkStore.ts (see downloadManager.ts/migrateLegacyAudio.ts).
 * Called last in both of those flows specifically so an interruption
 * before this point leaves the old row (or no row) rather than a
 * half-correct one pointing at chunks that were never fully written. */
export async function putCachedAudioFile(entry: CachedAudioFileEntry): Promise<void> {
  await (await getDb()).put('audioFiles', entry)
}

export async function deleteCachedAudioFile(sourceFileId: string): Promise<void> {
  const db = await getDb()
  const entry = await db.get('audioFiles', sourceFileId)
  if (entry) {
    await deleteAudioFileChunks(sourceFileId, entry.chunkCount)
    await deleteAudioManifest(sourceFileId)
  }
  await db.delete('audioFiles', sourceFileId)
}

export async function deleteCachedAudioFilesForBook(bookId: string): Promise<void> {
  const db = await getDb()
  const files = await db.getAllFromIndex('audioFiles', 'bookId', bookId)
  await Promise.all(files.map((f) => deleteAudioFileChunks(f.sourceFileId, f.chunkCount)))
  await Promise.all(files.map((f) => deleteAudioManifest(f.sourceFileId)))
  const tx = db.transaction('audioFiles', 'readwrite')
  await Promise.all(files.map((f) => tx.store.delete(f.sourceFileId)))
  await tx.done
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

// --- Resumable transfer progress (fresh downloads and legacy migrations) --
// Page context only — never read by the service worker. Lets a crash
// partway through a ~100-chunk write resume near where it left off instead
// of restarting (and potentially crashing again on) the same expensive
// operation from scratch.

export async function getTransferProgress(sourceFileId: string): Promise<AudioTransferProgressEntry | undefined> {
  return (await getDb()).get('audioTransferProgress', sourceFileId)
}

export async function putTransferProgress(entry: AudioTransferProgressEntry): Promise<void> {
  await (await getDb()).put('audioTransferProgress', entry)
}

export async function deleteTransferProgress(sourceFileId: string): Promise<void> {
  await (await getDb()).delete('audioTransferProgress', sourceFileId)
}
