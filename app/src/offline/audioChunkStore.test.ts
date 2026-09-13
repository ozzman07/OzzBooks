import { beforeEach, describe, expect, it } from 'vitest'
import {
  deleteAudioFileChunks,
  deleteAudioManifest,
  deleteStaleV2Cache,
  getAudioChunkBlob,
  getAudioManifest,
  hasAudioChunk,
  putAudioChunk,
  putAudioManifest,
} from './audioChunkStore'
import { installFakeCacheStorage } from '../../test/fakeCacheStorage'

beforeEach(() => {
  installFakeCacheStorage()
})

describe('chunk read/write/delete', () => {
  it('round-trips a chunk written and read back', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    await putAudioChunk('src-1', 0, new Blob([bytes]))
    expect(await hasAudioChunk('src-1', 0)).toBe(true)
    const blob = await getAudioChunkBlob('src-1', 0)
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes)
  })

  it('reports a chunk that was never written as absent', async () => {
    expect(await hasAudioChunk('src-1', 0)).toBe(false)
    expect(await getAudioChunkBlob('src-1', 0)).toBeUndefined()
  })

  it('deletes exactly the requested chunk range for a source file', async () => {
    await putAudioChunk('src-1', 0, new Blob([new Uint8Array(1)]))
    await putAudioChunk('src-1', 1, new Blob([new Uint8Array(1)]))
    await putAudioChunk('src-1', 2, new Blob([new Uint8Array(1)]))
    await deleteAudioFileChunks('src-1', 2) // only chunks 0 and 1
    expect(await hasAudioChunk('src-1', 0)).toBe(false)
    expect(await hasAudioChunk('src-1', 1)).toBe(false)
    expect(await hasAudioChunk('src-1', 2)).toBe(true) // out of the deleted range, untouched
  })

  it("doesn't confuse chunks between different source files", async () => {
    await putAudioChunk('src-a', 0, new Blob([new Uint8Array([9])]))
    await putAudioChunk('src-b', 0, new Blob([new Uint8Array([8])]))
    await deleteAudioFileChunks('src-a', 1)
    expect(await hasAudioChunk('src-a', 0)).toBe(false)
    expect(await hasAudioChunk('src-b', 0)).toBe(true)
  })
})

describe('manifest read/write/delete', () => {
  it('round-trips a manifest', async () => {
    const manifest = { totalSize: 1000, chunkSize: 100, chunkCount: 10, mimeType: 'audio/mp4' }
    await putAudioManifest('src-1', manifest)
    expect(await getAudioManifest('src-1')).toEqual(manifest)
  })

  it('returns undefined for a manifest that was never written', async () => {
    expect(await getAudioManifest('src-1')).toBeUndefined()
  })

  it('deletes a manifest', async () => {
    await putAudioManifest('src-1', { totalSize: 1, chunkSize: 1, chunkCount: 1, mimeType: 'audio/mp4' })
    await deleteAudioManifest('src-1')
    expect(await getAudioManifest('src-1')).toBeUndefined()
  })
})

describe('deleteStaleV2Cache', () => {
  it('is safe to call even when the stale cache never existed', async () => {
    await expect(deleteStaleV2Cache()).resolves.not.toThrow()
  })

  it('removes the named cache bucket if present', async () => {
    const cache = await caches.open('offline-audio-v1')
    await cache.put('/whatever', new Response('x'))
    await deleteStaleV2Cache()
    // Re-opening after delete gives a fresh, empty cache under the same name.
    const reopened = await caches.open('offline-audio-v1')
    expect(await reopened.match('/whatever')).toBeUndefined()
  })
})
