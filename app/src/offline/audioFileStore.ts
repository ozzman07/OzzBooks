import { getDb, type CachedAudioFileEntry } from './db'

export async function getCachedAudioFile(sourceFileId: string): Promise<CachedAudioFileEntry | undefined> {
  return (await getDb()).get('audioFiles', sourceFileId)
}

export async function getCachedAudioFilesForBook(bookId: string): Promise<CachedAudioFileEntry[]> {
  return (await getDb()).getAllFromIndex('audioFiles', 'bookId', bookId)
}

export async function getAllCachedAudioFiles(): Promise<CachedAudioFileEntry[]> {
  return (await getDb()).getAll('audioFiles')
}

export async function putCachedAudioFile(entry: CachedAudioFileEntry): Promise<void> {
  await (await getDb()).put('audioFiles', entry)
}

export async function deleteCachedAudioFile(sourceFileId: string): Promise<void> {
  await (await getDb()).delete('audioFiles', sourceFileId)
}

export async function deleteCachedAudioFilesForBook(bookId: string): Promise<void> {
  const db = await getDb()
  const files = await db.getAllFromIndex('audioFiles', 'bookId', bookId)
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
