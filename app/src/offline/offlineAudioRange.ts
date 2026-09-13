import { getAudioChunkBlob, getAudioManifest } from './audioChunkStore'

const OFFLINE_AUDIO_PREFIX = '/offline-audio/'
// Caps every response to a handful of chunks (~32MB with the 8MB chunk
// size) regardless of how large a range is requested — including an
// open-ended "give me everything from here" range, which real <audio>
// elements do issue in practice (confirmed via the spike test: iOS Safari
// requested `bytes=N-` on both initial load and after a seek). A real
// HTTP server can stream an arbitrarily long range straight from disk; we
// can't, since every byte here passes through JS. Returning an accurate,
// shorter 206 instead — validated end-to-end on a real iPhone via the
// spike test (deep seeks, lock/unlock, all played cleanly) — lets the
// client simply re-request the continuation, the same way it already
// tolerates a slow network connection.
const MAX_SERVED_CHUNKS = 4

export function offlineAudioUrl(sourceFileId: string): string {
  return `${OFFLINE_AUDIO_PREFIX}${encodeURIComponent(sourceFileId)}`
}

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
 * from the start) rather than rejected, per RFC 7233's guidance that a
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
 * given the incoming Range header (or null). Reads only from
 * audioChunkStore.ts (Cache Storage) — never IndexedDB, since this runs
 * inside the service worker. Returns a complete, already-known Response in
 * one shot rather than a ReadableStream: iOS can terminate an idle or
 * long-running service worker, and a multi-minute audiobook buffer can go
 * long stretches between reads, so a stream that depends on the SW staying
 * alive to keep answering pull() calls risks exactly the kind of silent
 * stall this mechanism exists to fix. */
export async function buildOfflineAudioResponse(sourceFileId: string, rangeHeader: string | null): Promise<Response> {
  const manifest = await getAudioManifest(sourceFileId)
  if (!manifest) return new Response(null, { status: 404 })

  const { totalSize, chunkSize, mimeType } = manifest
  const range = parseRangeHeader(rangeHeader, totalSize)

  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalSize}`, 'Accept-Ranges': 'bytes' },
    })
  }

  const start = range.kind === 'satisfiable' ? range.start : 0
  const requestedEnd = range.kind === 'satisfiable' ? range.end : totalSize - 1
  const cappedEnd = Math.min(requestedEnd, start + MAX_SERVED_CHUNKS * chunkSize - 1, totalSize - 1)

  const firstChunk = Math.floor(start / chunkSize)
  const lastChunk = Math.floor(cappedEnd / chunkSize)
  const parts: Blob[] = []
  for (let i = firstChunk; i <= lastChunk; i++) {
    const chunkBlob = await getAudioChunkBlob(sourceFileId, i)
    if (!chunkBlob) return new Response(null, { status: 500 })
    const sliceStart = i === firstChunk ? start - i * chunkSize : 0
    const sliceEnd = i === lastChunk ? cappedEnd - i * chunkSize + 1 : chunkBlob.size
    parts.push(chunkBlob.slice(sliceStart, sliceEnd))
  }

  const body = new Blob(parts, { type: mimeType })
  const isFullBody = range.kind === 'none' && cappedEnd === totalSize - 1
  const status = isFullBody ? 200 : 206
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Content-Length': String(body.size),
    'Accept-Ranges': 'bytes',
  }
  if (!isFullBody) headers['Content-Range'] = `bytes ${start}-${cappedEnd}/${totalSize}`
  return new Response(body, { status, headers })
}
