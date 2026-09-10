import { getCachedAudioFile } from './audioFileStore'
import { getCachedBookDetail } from './bookDetailCacheStore'
import type { CachedAudioFileEntry } from './db'

export const OFFLINE_AUDIO_PREFIX = '/offline-audio/'

export function offlineAudioUrl(sourceFileId: string): string {
  return `${OFFLINE_AUDIO_PREFIX}${encodeURIComponent(sourceFileId)}`
}

/** Returns the decoded sourceFileId if `pathname` is an offline-audio URL, else null. */
export function matchOfflineAudioPath(pathname: string): string | null {
  if (!pathname.startsWith(OFFLINE_AUDIO_PREFIX)) return null
  const id = pathname.slice(OFFLINE_AUDIO_PREFIX.length)
  return id ? decodeURIComponent(id) : null
}

// Book.format is 'm4b' | 'mp3_folder' | 'epub' | 'cbz' (types.ts) — only the
// first two are ever audio. Used as the backward-compat fallback for
// CachedAudioFileEntry rows downloaded before mimeType existed.
const FORMAT_MIME: Record<string, string> = {
  m4b: 'audio/mp4',
  mp3_folder: 'audio/mpeg',
}
const DEFAULT_MIME = 'audio/mp4' // this app's dominant/default audio format

async function resolveMimeType(entry: CachedAudioFileEntry): Promise<string> {
  if (entry.mimeType) return entry.mimeType
  const detail = await getCachedBookDetail(entry.bookId)
  const fromFormat = detail?.book.format ? FORMAT_MIME[detail.book.format] : undefined
  return fromFormat ?? DEFAULT_MIME
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
 * given the incoming Range header (or null). Stateless per call — no
 * shared mutable state across concurrent requests for the same file, so
 * overlapping in-flight range requests (Safari commonly issues several)
 * are independent and safe. Body is a sliced Blob (blob.slice() is lazy —
 * it doesn't read the underlying bytes until something actually consumes
 * the response), so this never materializes the whole cached file in
 * memory just to serve a small range out of it — the entire point of
 * this route existing instead of one giant object URL. */
export async function buildOfflineAudioResponse(sourceFileId: string, rangeHeader: string | null): Promise<Response> {
  const entry = await getCachedAudioFile(sourceFileId)
  if (!entry) return new Response(null, { status: 404 })

  const total = entry.sizeBytes
  const mimeType = await resolveMimeType(entry)
  const result = parseRangeHeader(rangeHeader, total)

  if (result.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
    })
  }
  if (result.kind === 'none') {
    return new Response(entry.blob, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' },
    })
  }
  const { start, end } = result
  return new Response(entry.blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
    },
  })
}
