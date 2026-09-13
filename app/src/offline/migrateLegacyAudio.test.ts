import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests, type LegacyCachedAudioFileEntry } from './db'
import { putCachedBookDetail } from './bookDetailCacheStore'
import { getCachedAudioFile, putTransferProgress } from './audioFileStore'
import { getAudioChunkBlob, getAudioManifest, putAudioChunk } from './audioChunkStore'
import { migrateLegacyAudioIfNeeded } from './migrateLegacyAudio'
import { DOWNLOAD_CHUNK_BYTES } from './downloadManager'
import { installFakeCacheStorage } from '../../test/fakeCacheStorage'
import type { Book } from '../types'

beforeEach(async () => {
  await resetDbForTests()
  installFakeCacheStorage()
})

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'Test Book',
    author: 'Test Author',
    status: 'active',
    isOrphanedConversion: false,
    format: 'm4b',
    totalDuration: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    chapters: [],
    ...overrides,
  }
}

// vitest/chai's toEqual on large TypedArrays is catastrophically slow — it
// enumerates every index as a generic object property (confirmed via a
// real OOM crash whose stack trace was entirely V8's for-in/GetOwnKeys
// machinery), not a bulk byte compare. Buffer.compare() is a fast native
// memcmp; use this for any multi-MB-scale byte comparison in these tests.
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length, 'byte length mismatch').toBe(expected.length)
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected)), 'byte content mismatch').toBe(0)
}

async function readAllChunks(sourceFileId: string, chunkCount: number): Promise<Uint8Array> {
  const blobs = []
  for (let i = 0; i < chunkCount; i++) {
    const blob = await getAudioChunkBlob(sourceFileId, i)
    if (!blob) throw new Error(`missing chunk ${i}`)
    blobs.push(blob)
  }
  return new Uint8Array(await new Blob(blobs).arrayBuffer())
}

describe('migrateLegacyAudioIfNeeded', () => {
  it('is a no-op for an already-migrated (metadata-only) row', async () => {
    const entry: LegacyCachedAudioFileEntry = {
      sourceFileId: 'src-1',
      bookId: 'book-1',
      sizeBytes: 4,
      chunkCount: 1,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      // no `blob` — already migrated
    }
    await migrateLegacyAudioIfNeeded(entry)
    // Nothing should have been written — no manifest, no chunk 0.
    expect(await getAudioManifest('src-1')).toBeUndefined()
  })

  it('moves a legacy blob into chunked Cache Storage and strips it from the IndexedDB row', async () => {
    const totalSize = 2.5 * DOWNLOAD_CHUNK_BYTES
    const bytes = new Uint8Array(totalSize)
    for (let i = 0; i < totalSize; i++) bytes[i] = i % 256
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-1',
      bookId: 'book-1',
      sizeBytes: totalSize,
      chunkCount: 0, // stale/irrelevant on a legacy row — migration recomputes it
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: new Blob([bytes], { type: 'audio/mpeg' }),
    }
    await migrateLegacyAudioIfNeeded(legacy)

    const stored = await getCachedAudioFile('legacy-1')
    expect((stored as LegacyCachedAudioFileEntry | undefined)?.blob).toBeUndefined()
    expect(stored?.chunkCount).toBe(3)
    expect(stored?.sizeBytes).toBe(totalSize)

    const manifest = await getAudioManifest('legacy-1')
    expect(manifest).toEqual({ totalSize, chunkSize: DOWNLOAD_CHUNK_BYTES, chunkCount: 3, mimeType: 'audio/mpeg' })

    const rebuilt = await readAllChunks('legacy-1', 3)
    expectBytesEqual(rebuilt, bytes)
  })

  it('resumes from existing progress instead of re-writing already-migrated chunks', async () => {
    const totalSize = 3 * DOWNLOAD_CHUNK_BYTES
    const bytes = new Uint8Array(totalSize)
    for (let i = 0; i < totalSize; i++) bytes[i] = i % 256

    // Simulate a crash right after chunk 0 was written on a prior attempt.
    await putAudioChunk('legacy-2', 0, new Blob([bytes.slice(0, DOWNLOAD_CHUNK_BYTES)]))
    await putTransferProgress({
      sourceFileId: 'legacy-2',
      bookId: 'book-1',
      chunksWritten: 1,
      chunkCount: 3,
      totalSize,
      mimeType: 'audio/mp4',
    })

    let chunk1Written = false
    let chunk2Written = false
    const originalSlice = Blob.prototype.slice
    // Spy on which slices of the ORIGINAL legacy blob get read, to confirm
    // chunk 0 is never touched again.
    const legacyBlob = new Blob([bytes])
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-2',
      bookId: 'book-1',
      sizeBytes: totalSize,
      chunkCount: 0,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: legacyBlob,
    }
    legacyBlob.slice = function (this: Blob, start?: number, end?: number) {
      if (start === DOWNLOAD_CHUNK_BYTES) chunk1Written = true
      if (start === 2 * DOWNLOAD_CHUNK_BYTES) chunk2Written = true
      if (start === 0) throw new Error('should not re-read chunk 0 — it was already migrated')
      return originalSlice.call(this, start, end)
    }

    await migrateLegacyAudioIfNeeded(legacy)

    expect(chunk1Written).toBe(true)
    expect(chunk2Written).toBe(true)
    const rebuilt = await readAllChunks('legacy-2', 3)
    expectBytesEqual(rebuilt, bytes)
  })

  it("uses the blob's own type if present, without consulting book detail", async () => {
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-3',
      bookId: 'book-1',
      sizeBytes: 3,
      chunkCount: 0,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: new Blob([new Uint8Array(3)], { type: 'audio/mpeg' }),
    }
    await migrateLegacyAudioIfNeeded(legacy)
    expect((await getAudioManifest('legacy-3'))?.mimeType).toBe('audio/mpeg')
  })

  it('falls back to the cached book detail format when the blob has no type (mp3_folder)', async () => {
    await putCachedBookDetail('book-mp3', makeBook({ format: 'mp3_folder' }))
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-4',
      bookId: 'book-mp3',
      sizeBytes: 3,
      chunkCount: 0,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: new Blob([new Uint8Array(3)]), // no type
    }
    await migrateLegacyAudioIfNeeded(legacy)
    expect((await getAudioManifest('legacy-4'))?.mimeType).toBe('audio/mpeg')
  })

  it('falls back to the default mime type when neither the blob nor book detail has one', async () => {
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-5',
      bookId: 'book-unknown',
      sizeBytes: 3,
      chunkCount: 0,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: new Blob([new Uint8Array(3)]),
    }
    await migrateLegacyAudioIfNeeded(legacy)
    expect((await getAudioManifest('legacy-5'))?.mimeType).toBe('audio/mp4')
  })
})
