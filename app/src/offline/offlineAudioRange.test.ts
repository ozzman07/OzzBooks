import { describe, expect, it } from 'vitest'
import { offlineAudioUrl } from './audioFileStore'
import { buildOfflineAudioResponse, matchOfflineAudioPath, parseRangeHeader } from './offlineAudioRange'

const AUDIO_CACHE_NAME = 'offline-audio-v1'

async function seed(sourceFileId: string, bytes: Uint8Array<ArrayBuffer>, contentType = 'audio/mp4') {
  const cache = await caches.open(AUDIO_CACHE_NAME)
  await cache.put(
    offlineAudioUrl(sourceFileId),
    new Response(new Blob([bytes]), {
      headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) },
    }),
  )
}

describe('matchOfflineAudioPath', () => {
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

  it('treats a missing header as "none" (serve full body)', () => {
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
  const bytes = new Uint8Array(1000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256

  async function bodyBytes(res: Response): Promise<Uint8Array> {
    return new Uint8Array(await res.arrayBuffer())
  }

  it('404s when nothing is cached for that id', async () => {
    const res = await buildOfflineAudioResponse('missing', null)
    expect(res.status).toBe(404)
  })

  it('returns the full body with a 200 when there is no Range header', async () => {
    await seed('src-1', bytes, 'audio/mp4')
    const res = await buildOfflineAudioResponse('src-1', null)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('audio/mp4')
    expect(res.headers.get('Content-Length')).toBe('1000')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(await bodyBytes(res)).toEqual(bytes)
  })

  it('returns a byte-exact 206 for a satisfiable range', async () => {
    await seed('src-2', bytes, 'audio/mp4')
    const res = await buildOfflineAudioResponse('src-2', 'bytes=100-199')
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 100-199/1000')
    expect(res.headers.get('Content-Length')).toBe('100')
    expect(await bodyBytes(res)).toEqual(bytes.slice(100, 200))
  })

  it('returns 416 with Content-Range */total for an unsatisfiable range', async () => {
    await seed('src-3', bytes)
    const res = await buildOfflineAudioResponse('src-3', 'bytes=5000-6000')
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */1000')
  })

  it('reads Content-Type straight off the cached response, no fallback logic', async () => {
    await seed('src-4', bytes, 'audio/mpeg')
    const res = await buildOfflineAudioResponse('src-4', null)
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
  })
})
