import { offlineAudioUrl } from './audioFileStore'

const OFFLINE_AUDIO_PREFIX = '/offline-audio/'
const AUDIO_CACHE_NAME = 'offline-audio-v1'

/** Returns the decoded sourceFileId if `pathname` is an offline-audio URL, else null. */
export function matchOfflineAudioPath(pathname: string): string | null {
  if (!pathname.startsWith(OFFLINE_AUDIO_PREFIX)) return null
  const id = pathname.slice(OFFLINE_AUDIO_PREFIX.length)
  return id ? decodeURIComponent(id) : null
}

type RangeResult =
  | { kind: 'none' }
  | { kind: 'satisfiable'; start: number; end: number }
  | { kind: 'unsatisfiable' }

/** Parses a `Range: bytes=...` header per RFC 7233 §2.1/§3.1 basics:
 * bytes=X-Y, bytes=X- (open-ended), bytes=-N (suffix). Multi-range and
 * syntactically invalid headers are treated as 'none' (ignored, serve
 * the full body) rather than rejected, per RFC 7233's guidance that a
 * server MAY ignore a Range header it doesn't want to honor — this app's
 * own <audio> element never sends multi-range requests in practice. */
export function parseRangeHeader(rangeHeader: string | null, totalSize: number): RangeResult {
  if (!rangeHeader) return { kind: 'none' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return { kind: 'none' }
  const [, startStr, endStr] = match
  if (startStr === '' && endStr === '') return { kind: 'none' }
  if (totalSize === 0) return { kind: 'unsatisfiable' }

  let start: number
  let end: number
  if (startStr === '') {
    const suffixLength = Number(endStr)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, totalSize - suffixLength)
    end = totalSize - 1
  } else {
    start = Number(startStr)
    end = endStr === '' ? totalSize - 1 : Number(endStr)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || start > end) {
    return { kind: 'unsatisfiable' }
  }
  return { kind: 'satisfiable', start, end: Math.min(end, totalSize - 1) }
}

/** Builds the full Response for a GET to /offline-audio/<sourceFileId>,
 * given the incoming Range header (or null). Reads only from Cache
 * Storage — deliberately no IndexedDB access anywhere in this file, since
 * this runs inside the service worker and Safari has a documented history
 * of unreliable IndexedDB access specifically from service workers (see
 * db.ts's CachedAudioFileEntry doc comment). Content-Type is read straight
 * off the cached Response's own headers — audioFileStore.ts resolves it
 * once at write time, so there's no fallback chain to run here. Body is a
 * sliced Blob (blob.slice() is lazy — it doesn't read the underlying bytes
 * until something actually consumes the response), so this never
 * materializes the whole cached file in memory just to serve a small
 * range out of it. */
export async function buildOfflineAudioResponse(sourceFileId: string, rangeHeader: string | null): Promise<Response> {
  const cache = await caches.open(AUDIO_CACHE_NAME)
  const cached = await cache.match(offlineAudioUrl(sourceFileId))
  if (!cached) return new Response(null, { status: 404 })

  const blob = await cached.blob()
  const total = blob.size
  const mimeType = cached.headers.get('Content-Type') ?? 'audio/mp4'
  const result = parseRangeHeader(rangeHeader, total)

  if (result.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
    })
  }
  if (result.kind === 'none') {
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' },
    })
  }
  const { start, end } = result
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
    },
  })
}
