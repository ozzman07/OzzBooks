import { Readable } from 'node:stream'
import type { Request, Response } from 'express'
import type { ChapterRow, SourceRow } from '../../types.js'
import { getProvider } from '../../integrations/remote/registry.js'
import { getValidAccessToken } from '../../integrations/remote/credentials.js'

const CONTENT_TYPE_BY_FORMAT: Record<string, string> = {
  m4b: 'audio/mp4',
  mp3_folder: 'audio/mpeg',
}

/** chapters.file_path for a remote chapter is "<providerId>://<fileId>"
 * (see remoteScan.ts) — generic parsing, doesn't assume "gdrive"
 * specifically, so this stays provider-agnostic. */
function parseRemoteFileId(filePath: string): string | null {
  const match = /^[a-z0-9]+:\/\/(.+)$/i.exec(filePath)
  return match ? match[1] : null
}

/**
 * Range-forwarding proxy for a remote chapter: forwards the client's
 * Range header to the provider's download endpoint and pipes the
 * response straight through without ever buffering it whole in memory
 * or writing it to disk — satisfies "files stay genuinely remote" even
 * for a full-file (no Range header) request, not just partial ones.
 */
export async function proxyRemoteStream(
  req: Request,
  res: Response,
  source: SourceRow,
  chapter: ChapterRow,
  bookFormat: string,
): Promise<void> {
  const provider = getProvider(source.type)
  if (!provider) {
    res.status(503).json({ error: 'source unavailable', detail: `No provider registered for source type "${source.type}" yet` })
    return
  }

  const fileId = parseRemoteFileId(chapter.file_path)
  if (!fileId) {
    res.status(500).json({ error: 'malformed remote file reference', detail: chapter.file_path })
    return
  }

  let credentials
  try {
    credentials = await getValidAccessToken(source, provider)
  } catch (err) {
    // getValidAccessToken already flipped credentials_status to
    // needs_reconnect for a permanent failure — surface that distinction
    // to the client rather than a generic error, so the frontend's retry
    // UX can eventually special-case "reconnect needed" vs. "try again".
    res.status(503).json({ error: 'source unavailable', sourceStatus: 'needs_reconnect', detail: String(err) })
    return
  }

  const { url, headers } = await provider.getMetadataAccess(source, credentials, fileId)
  const upstreamHeaders: Record<string, string> = { ...headers }
  const rangeHeader = req.headers.range
  if (typeof rangeHeader === 'string') upstreamHeaders.Range = rangeHeader

  // Aborts the upstream fetch if the client disconnects mid-stream
  // (backing out of a book, closing the tab) — this is a long-running
  // family server that isn't restarted often, so leaked upstream
  // connections would otherwise accumulate silently over weeks.
  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

  let upstream: globalThis.Response
  try {
    upstream = await fetch(url, { headers: upstreamHeaders, signal: abortController.signal })
  } catch (err) {
    if (abortController.signal.aborted) return // client already gone, nothing to respond to
    res.status(502).json({ error: 'upstream fetch failed', detail: String(err) })
    return
  }

  if (upstream.status === 401 || upstream.status === 403) {
    res.status(503).json({ error: 'source unavailable', sourceStatus: 'needs_reconnect', detail: `Upstream returned ${upstream.status}` })
    return
  }
  if (upstream.status === 404) {
    // Genuine "file deleted on the remote source outside the app" — same
    // treatment as a missing local file: propagate 404, don't touch
    // books.status (only a scan's missing-marking pass does that).
    res.status(404).json({ error: 'audio file not found on remote source' })
    return
  }
  if (!upstream.ok && upstream.status !== 206) {
    res.status(502).json({ error: 'upstream fetch failed', detail: `Unexpected upstream status ${upstream.status}` })
    return
  }

  res.status(upstream.status)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', CONTENT_TYPE_BY_FORMAT[bookFormat] ?? 'application/octet-stream')
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) res.setHeader('Content-Length', contentLength)
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) res.setHeader('Content-Range', contentRange)

  if (!upstream.body) {
    res.end()
    return
  }
  Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res)
}
