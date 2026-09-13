import { beforeEach, describe, expect, it } from 'vitest'
import { putAudioChunk, putAudioManifest } from './audioChunkStore'
import { buildOfflineAudioResponse, matchOfflineAudioPath, offlineAudioUrl, parseRangeHeader } from './offlineAudioRange'
import { installFakeCacheStorage } from '../../test/fakeCacheStorage'

beforeEach(() => {
  installFakeCacheStorage()
})

describe('offlineAudioUrl / matchOfflineAudioPath', () => {
  it('round-trips a plain id', () => {
    expect(matchOfflineAudioPath(offlineAudioUrl('abc-123'))).toBe('abc-123')
  })

  it('URI-encodes and decodes an id with special characters', () => {
    const id = 'source/with spaces&stuff'
    expect(matchOfflineAudioPath(offlineAudioUrl(id))).toBe(id)
  })

  it('returns null for an unrelated path', () => {
    expect(matchOfflineAudioPath('/api/books/1')).toBeNull()
  })

  it('returns null for the bare prefix with no id', () => {
    expect(matchOfflineAudioPath('/offline-audio/')).toBeNull()
  })
})

describe('parseRangeHeader', () => {
  const total = 1000

  it('treats a missing header as "none" (serve from the start)', () => {
    expect(parseRangeHeader(null, total)).toEqual({ kind: 'none' })
  })

  it('parses a bounded range', () => {
    expect(parseRangeHeader('bytes=100-199', total)).toEqual({ kind: 'satisfiable', start: 100, end: 199 })
  })

  it('parses an open-ended range', () => {
    expect(parseRangeHeader('bytes=900-', total)).toEqual({ kind: 'satisfiable', start: 900, end: 999 })
  })

  it('parses a suffix range', () => {
    expect(parseRangeHeader('bytes=-100', total)).toEqual({ kind: 'satisfiable', start: 900, end: 999 })
  })

  it('clamps an end beyond the file size', () => {
    expect(parseRangeHeader('bytes=990-9999', total)).toEqual({ kind: 'satisfiable', start: 990, end: 999 })
  })

  it('is unsatisfiable when start is at or beyond the total size', () => {
    expect(parseRangeHeader('bytes=1000-1010', total)).toEqual({ kind: 'unsatisfiable' })
  })

  it('is unsatisfiable when start > end', () => {
    expect(parseRangeHeader('bytes=500-100', total)).toEqual({ kind: 'unsatisfiable' })
  })

  it('is unsatisfiable for a zero-or-negative suffix length', () => {
    expect(parseRangeHeader('bytes=-0', total)).toEqual({ kind: 'unsatisfiable' })
  })

  it('is unsatisfiable against a zero-byte file when a range is given', () => {
    expect(parseRangeHeader('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('treats a malformed header as "none" rather than rejecting it', () => {
    expect(parseRangeHeader('not-a-range', total)).toEqual({ kind: 'none' })
  })

  it('treats a multi-range header as "none" (unsupported, ignored per RFC 7233)', () => {
    expect(parseRangeHeader('bytes=0-99,200-299', total)).toEqual({ kind: 'none' })
  })
})

describe('buildOfflineAudioResponse', () => {
  // The manifest declares its own chunkSize — buildOfflineAudioResponse
  // has no hardcoded 8MB anywhere, only the MAX_SERVED_CHUNKS=4 cap — so a
  // small fake chunk size here exercises exactly the same boundary math as
  // production with tiny, fast-to-construct fixtures. 8 chunks of 100
  // bytes, with a short final chunk (30 bytes) to also cover that
  // boundary: a "no Range"/open-ended request from partway through should
  // get capped well before reaching the end (needs > 4 chunks total).
  const chunkSize = 100
  const chunkCount = 8
  const totalSize = (chunkCount - 1) * chunkSize + 30
  const fullBytes = new Uint8Array(totalSize)
  for (let i = 0; i < totalSize; i++) fullBytes[i] = i % 256

  async function seed(sourceFileId: string, mimeType = 'audio/mp4') {
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, totalSize)
      await putAudioChunk(sourceFileId, i, new Blob([fullBytes.slice(start, end)]))
    }
    await putAudioManifest(sourceFileId, { totalSize, chunkSize, chunkCount, mimeType })
  }

  async function bodyBytes(res: Response): Promise<Uint8Array> {
    return new Uint8Array(await res.arrayBuffer())
  }

  it('404s when nothing is cached for that id', async () => {
    const res = await buildOfflineAudioResponse('missing', null)
    expect(res.status).toBe(404)
  })

  it('returns a 200 covering the whole file when it fits within the chunk cap', async () => {
    // A tiny single-chunk file with no Range header should come back as a
    // real 200 with the full body, not an artificially capped 206.
    await putAudioChunk('small-file', 0, new Blob([new Uint8Array(50)]))
    await putAudioManifest('small-file', { totalSize: 50, chunkSize, chunkCount: 1, mimeType: 'audio/mp4' })
    const res = await buildOfflineAudioResponse('small-file', null)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe('50')
  })

  it('caps a "no Range header" request on a large file to a short 206, never the whole thing', async () => {
    await seed('src-full')
    const res = await buildOfflineAudioResponse('src-full', null)
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-${4 * chunkSize - 1}/${totalSize}`)
    expect(await bodyBytes(res)).toEqual(fullBytes.slice(0, 4 * chunkSize))
  })

  it('caps an open-ended Range request the same way a real <audio> element issues after a deep seek', async () => {
    await seed('src-open-ended')
    const start = 2 * chunkSize + 5 // partway into chunk 2
    const res = await buildOfflineAudioResponse('src-open-ended', `bytes=${start}-`)
    expect(res.status).toBe(206)
    const expectedEnd = start + 4 * chunkSize - 1 // chunks 2-5, well short of the 8-chunk file
    expect(res.headers.get('Content-Range')).toBe(`bytes ${start}-${expectedEnd}/${totalSize}`)
    expect(await bodyBytes(res)).toEqual(fullBytes.slice(start, expectedEnd + 1))
  })

  it('returns a byte-exact 206 for a small satisfiable range entirely within the cap', async () => {
    await seed('src-small-range')
    const res = await buildOfflineAudioResponse('src-small-range', 'bytes=10-19')
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 10-19/' + totalSize)
    expect(res.headers.get('Content-Length')).toBe('10')
    expect(await bodyBytes(res)).toEqual(fullBytes.slice(10, 20))
  })

  it('serves the true (short) final chunk correctly right at the end of the file', async () => {
    await seed('src-tail')
    const res = await buildOfflineAudioResponse('src-tail', `bytes=${totalSize - 10}-`)
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe(`bytes ${totalSize - 10}-${totalSize - 1}/${totalSize}`)
    expect(await bodyBytes(res)).toEqual(fullBytes.slice(totalSize - 10))
  })

  it('returns 416 with Content-Range */total for an unsatisfiable range', async () => {
    await seed('src-bad-range')
    const res = await buildOfflineAudioResponse('src-bad-range', `bytes=${totalSize + 100}-${totalSize + 200}`)
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe(`bytes */${totalSize}`)
  })

  it('reads Content-Type straight off the manifest, no fallback chain in this file', async () => {
    await seed('src-mime', 'audio/mpeg')
    const res = await buildOfflineAudioResponse('src-mime', null)
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
  })

  it('500s if the manifest claims a chunk that is not actually present', async () => {
    await putAudioManifest('src-missing-chunk', { totalSize: chunkSize, chunkSize, chunkCount: 1, mimeType: 'audio/mp4' })
    // Deliberately never wrote chunk 0.
    const res = await buildOfflineAudioResponse('src-missing-chunk', null)
    expect(res.status).toBe(500)
  })
})
