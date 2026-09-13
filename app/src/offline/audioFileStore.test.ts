import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests } from './db'
import {
  deleteCachedAudioFile,
  deleteCachedAudioFilesForBook,
  getCachedAudioFile,
  putCachedAudioFile,
} from './audioFileStore'
import { hasAudioChunk, putAudioChunk, putAudioManifest, getAudioManifest } from './audioChunkStore'
import { installFakeCacheStorage } from '../../test/fakeCacheStorage'

beforeEach(async () => {
  await resetDbForTests()
  installFakeCacheStorage()
})

async function seedFullEntry(sourceFileId: string, bookId: string, chunkCount: number) {
  for (let i = 0; i < chunkCount; i++) {
    await putAudioChunk(sourceFileId, i, new Blob([new Uint8Array(1)]))
  }
  await putAudioManifest(sourceFileId, { totalSize: chunkCount, chunkSize: 1, chunkCount, mimeType: 'audio/mp4' })
  await putCachedAudioFile({
    sourceFileId,
    bookId,
    sizeBytes: chunkCount,
    chunkCount,
    downloadedAt: 'x',
    lastPlayedAt: 'x',
  })
}

describe('deleteCachedAudioFile', () => {
  it('removes the metadata row, the manifest, and every chunk — not just the row', async () => {
    await seedFullEntry('src-1', 'book-1', 3)
    await deleteCachedAudioFile('src-1')

    expect(await getCachedAudioFile('src-1')).toBeUndefined()
    expect(await getAudioManifest('src-1')).toBeUndefined()
    expect(await hasAudioChunk('src-1', 0)).toBe(false)
    expect(await hasAudioChunk('src-1', 1)).toBe(false)
    expect(await hasAudioChunk('src-1', 2)).toBe(false)
  })

  it('is a harmless no-op for a sourceFileId that was never cached', async () => {
    await expect(deleteCachedAudioFile('never-existed')).resolves.not.toThrow()
  })
})

describe('deleteCachedAudioFilesForBook', () => {
  it('removes chunks and manifests for every file belonging to the book, leaving other books untouched', async () => {
    await seedFullEntry('src-a', 'book-x', 2)
    await seedFullEntry('src-b', 'book-x', 3)
    await seedFullEntry('src-c', 'book-y', 1) // different book, must survive

    await deleteCachedAudioFilesForBook('book-x')

    expect(await getCachedAudioFile('src-a')).toBeUndefined()
    expect(await getCachedAudioFile('src-b')).toBeUndefined()
    expect(await hasAudioChunk('src-a', 0)).toBe(false)
    expect(await hasAudioChunk('src-b', 2)).toBe(false)

    expect(await getCachedAudioFile('src-c')).not.toBeUndefined()
    expect(await hasAudioChunk('src-c', 0)).toBe(true)
  })
})
