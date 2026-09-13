// Cache Storage only — deliberately no import from db.ts/IndexedDB anywhere
// in this file. This is what the service worker reads from to serve
// playback (see offlineAudioRange.ts), and Safari has a documented history
// of unreliable IndexedDB access specifically from service workers —
// keeping this file's only storage dependency on Cache Storage (already
// proven reliable here: it's what this app's own precaching already uses)
// means the serving path never has to find out the hard way.
const AUDIO_CHUNK_CACHE = 'offline-audio-chunks-v1'
const AUDIO_MANIFEST_CACHE = 'offline-audio-manifest-v1'
// Name attempt 2 used for both bytes and manifest in one cache — may still
// physically exist on a device that had that build installed. Not read
// from; only ever deleted (see deleteStaleV2Cache, called from sw.ts).
const STALE_V2_CACHE = 'offline-audio-v1'

export interface AudioManifest {
  totalSize: number
  chunkSize: number
  chunkCount: number
  mimeType: string
}

export function chunkKey(sourceFileId: string, index: number): string {
  return `/offline-audio-chunk/${encodeURIComponent(sourceFileId)}/${index}`
}

function manifestKey(sourceFileId: string): string {
  return `/offline-audio-manifest/${encodeURIComponent(sourceFileId)}`
}

export async function putAudioChunk(sourceFileId: string, index: number, blob: Blob): Promise<void> {
  const cache = await caches.open(AUDIO_CHUNK_CACHE)
  await cache.put(chunkKey(sourceFileId, index), new Response(blob))
}

export async function hasAudioChunk(sourceFileId: string, index: number): Promise<boolean> {
  const cache = await caches.open(AUDIO_CHUNK_CACHE)
  return (await cache.match(chunkKey(sourceFileId, index))) !== undefined
}

export async function getAudioChunkBlob(sourceFileId: string, index: number): Promise<Blob | undefined> {
  const cache = await caches.open(AUDIO_CHUNK_CACHE)
  const res = await cache.match(chunkKey(sourceFileId, index))
  return res?.blob()
}

export async function putAudioManifest(sourceFileId: string, manifest: AudioManifest): Promise<void> {
  const cache = await caches.open(AUDIO_MANIFEST_CACHE)
  await cache.put(manifestKey(sourceFileId), new Response(JSON.stringify(manifest)))
}

export async function getAudioManifest(sourceFileId: string): Promise<AudioManifest | undefined> {
  const cache = await caches.open(AUDIO_MANIFEST_CACHE)
  const res = await cache.match(manifestKey(sourceFileId))
  return res?.json()
}

export async function deleteAudioManifest(sourceFileId: string): Promise<void> {
  const cache = await caches.open(AUDIO_MANIFEST_CACHE)
  await cache.delete(manifestKey(sourceFileId))
}

export async function deleteAudioFileChunks(sourceFileId: string, chunkCount: number): Promise<void> {
  const cache = await caches.open(AUDIO_CHUNK_CACHE)
  await Promise.all(Array.from({ length: chunkCount }, (_, i) => cache.delete(chunkKey(sourceFileId, i))))
}

/** One-time cleanup of the reverted attempt 2's cache bucket, which may
 * still physically exist on a device that briefly ran that build. Called
 * from sw.ts's activate handler — safe to call unconditionally, and to
 * call repeatedly (caches.delete on an already-gone cache is a no-op). */
export async function deleteStaleV2Cache(): Promise<void> {
  await caches.delete(STALE_V2_CACHE)
}
