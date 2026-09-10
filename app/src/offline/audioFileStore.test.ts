import { beforeEach, describe, expect, it } from 'vitest'
import { resetDbForTests, type LegacyCachedAudioFileEntry } from './db'
import { putCachedBookDetail } from './bookDetailCacheStore'
import {
  deleteCachedAudioFile,
  deleteCachedAudioFilesForBook,
  getCachedAudioFile,
  migrateLegacyAudioBlobIfNeeded,
  offlineAudioUrl,
  putCachedAudioFile,
} from './audioFileStore'
import type { Book } from '../types'

const AUDIO_CACHE_NAME = 'offline-audio-v1'

beforeEach(async () => {
  await resetDbForTests()
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

async function cachedBytes(sourceFileId: string): Promise<Uint8Array | undefined> {
  const cache = await caches.open(AUDIO_CACHE_NAME)
  const res = await cache.match(offlineAudioUrl(sourceFileId))
  if (!res) return undefined
  return new Uint8Array(await res.arrayBuffer())
}

describe('putCachedAudioFile', () => {
  it('writes bytes to Cache Storage and metadata to IndexedDB', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    await putCachedAudioFile(
      {
        sourceFileId: 'src-1',
        bookId: 'book-1',
        sizeBytes: 4,
        downloadedAt: '2026-01-01T00:00:00.000Z',
        lastPlayedAt: '2026-01-01T00:00:00.000Z',
      },
      new Blob([bytes]),
      'audio/mp4',
    )

    const metadata = await getCachedAudioFile('src-1')
    expect(metadata?.sizeBytes).toBe(4)
    expect((metadata as { blob?: Blob })?.blob).toBeUndefined()

    const cache = await caches.open(AUDIO_CACHE_NAME)
    const res = await cache.match(offlineAudioUrl('src-1'))
    expect(res?.headers.get('Content-Type')).toBe('audio/mp4')
    expect(await cachedBytes('src-1')).toEqual(bytes)
  })
})

describe('deleteCachedAudioFile / deleteCachedAudioFilesForBook', () => {
  it('clears both the metadata row and the Cache Storage entry', async () => {
    await putCachedAudioFile(
      { sourceFileId: 'src-1', bookId: 'book-1', sizeBytes: 4, downloadedAt: 'x', lastPlayedAt: 'x' },
      new Blob([new Uint8Array(4)]),
      'audio/mp4',
    )
    await deleteCachedAudioFile('src-1')
    expect(await getCachedAudioFile('src-1')).toBeUndefined()
    expect(await cachedBytes('src-1')).toBeUndefined()
  })

  it('clears every file belonging to a book from both layers', async () => {
    await putCachedAudioFile(
      { sourceFileId: 'src-a', bookId: 'book-x', sizeBytes: 4, downloadedAt: 'x', lastPlayedAt: 'x' },
      new Blob([new Uint8Array(4)]),
      'audio/mp4',
    )
    await putCachedAudioFile(
      { sourceFileId: 'src-b', bookId: 'book-x', sizeBytes: 4, downloadedAt: 'x', lastPlayedAt: 'x' },
      new Blob([new Uint8Array(4)]),
      'audio/mp4',
    )
    await deleteCachedAudioFilesForBook('book-x')
    expect(await getCachedAudioFile('src-a')).toBeUndefined()
    expect(await getCachedAudioFile('src-b')).toBeUndefined()
    expect(await cachedBytes('src-a')).toBeUndefined()
    expect(await cachedBytes('src-b')).toBeUndefined()
  })
})

describe('migrateLegacyAudioBlobIfNeeded', () => {
  it('is a no-op for an already-migrated (metadata-only) row', async () => {
    await putCachedAudioFile(
      { sourceFileId: 'src-1', bookId: 'book-1', sizeBytes: 4, downloadedAt: 'x', lastPlayedAt: 'x' },
      new Blob([new Uint8Array([9, 9, 9, 9])]),
      'audio/mp4',
    )
    const metadata = (await getCachedAudioFile('src-1'))!
    await migrateLegacyAudioBlobIfNeeded(metadata as LegacyCachedAudioFileEntry)
    // Unchanged: still the original bytes, no duplicate write.
    expect(await cachedBytes('src-1')).toEqual(new Uint8Array([9, 9, 9, 9]))
  })

  it('moves a legacy blob into Cache Storage and strips it from the IndexedDB row', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-1',
      bookId: 'book-1',
      sizeBytes: 3,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: new Blob([bytes], { type: 'audio/mpeg' }),
    }
    await migrateLegacyAudioBlobIfNeeded(legacy)

    expect(await cachedBytes('legacy-1')).toEqual(bytes)
    const stored = await getCachedAudioFile('legacy-1')
    expect((stored as { blob?: Blob })?.blob).toBeUndefined()
    expect(stored?.sizeBytes).toBe(3)
  })

  it('uses the blob\'s own type if present, without consulting book detail', async () => {
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-2',
      bookId: 'book-1',
      sizeBytes: 3,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: new Blob([new Uint8Array(3)], { type: 'audio/mpeg' }),
    }
    await migrateLegacyAudioBlobIfNeeded(legacy)
    const cache = await caches.open(AUDIO_CACHE_NAME)
    const res = await cache.match(offlineAudioUrl('legacy-2'))
    expect(res?.headers.get('Content-Type')).toBe('audio/mpeg')
  })

  it('falls back to the cached book detail format when the blob has no type (mp3_folder)', async () => {
    await putCachedBookDetail('book-mp3', makeBook({ format: 'mp3_folder' }))
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-3',
      bookId: 'book-mp3',
      sizeBytes: 3,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: new Blob([new Uint8Array(3)]), // no type
    }
    await migrateLegacyAudioBlobIfNeeded(legacy)
    const cache = await caches.open(AUDIO_CACHE_NAME)
    const res = await cache.match(offlineAudioUrl('legacy-3'))
    expect(res?.headers.get('Content-Type')).toBe('audio/mpeg')
  })

  it('falls back to the default mime type when neither the blob nor book detail has one', async () => {
    const legacy: LegacyCachedAudioFileEntry = {
      sourceFileId: 'legacy-4',
      bookId: 'book-unknown',
      sizeBytes: 3,
      downloadedAt: 'x',
      lastPlayedAt: 'x',
      blob: new Blob([new Uint8Array(3)]),
    }
    await migrateLegacyAudioBlobIfNeeded(legacy)
    const cache = await caches.open(AUDIO_CACHE_NAME)
    const res = await cache.match(offlineAudioUrl('legacy-4'))
    expect(res?.headers.get('Content-Type')).toBe('audio/mp4')
  })
})
