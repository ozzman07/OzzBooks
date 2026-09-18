import { tokenizer as createRangeTokenizer, parseContentRange } from '@tokenizer/range'
import type { IRangeRequestClient, IHeadRequestInfo, IRangeRequestResponse, IContentRangeType } from '@tokenizer/range'
import { parseFromTokenizer } from 'music-metadata'
import type { IAudioMetadata } from 'music-metadata'
import { readContainerInfoFromUrl } from '../../../ingestion/ffprobe.js'
import { isGenericChapterLabel } from '../../../ingestion/m4b.js'
import { narratorFrom, type IngestedBook, type IngestedChapter } from '../../../ingestion/mp3Folder.js'
import { DriveHttpError, withDriveLimit, withDriveRetry } from '../httpRetry.js'

/**
 * A minimal IRangeRequestClient over fetch(), adding an Authorization
 * header to every request. @tokenizer/http's own HttpClient — the
 * package's advertised convenience wrapper — does NOT support custom
 * headers at all (confirmed by reading its source directly), which is a
 * hard requirement for Drive's alt=media endpoint. This mirrors that
 * reference implementation's request/response handling closely, just
 * with headers attached, using the lower-level @tokenizer/range package
 * @tokenizer/http itself is built on.
 */
class AuthenticatedRangeClient implements IRangeRequestClient {
  private readonly abortController = new AbortController()

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  async getHeadInfo(): Promise<IHeadRequestInfo> {
    return withDriveRetry('tag-parse HEAD', () =>
      withDriveLimit(async () => {
        const res = await fetch(this.url, { method: 'HEAD', headers: this.headers, signal: this.abortController.signal })
        if (!res.ok) {
          throw new DriveHttpError(`Unexpected HTTP response status=${res.status}`, res.status)
        }
        return this.toHeadInfo(res)
      }),
    )
  }

  async getResponse(method: string, range?: [number, number]): Promise<IRangeRequestResponse> {
    return withDriveRetry(`tag-parse ${method}${range ? ` ${range[0]}-${range[1]}` : ''}`, () =>
      withDriveLimit(async () => {
        const headers = { ...this.headers }
        if (range) headers.Range = `bytes=${range[0]}-${range[1]}`
        const res = await fetch(this.url, { method, headers, signal: this.abortController.signal })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new DriveHttpError(`Unexpected HTTP response status=${res.status}`, res.status, body)
        }
        return {
          ...this.toHeadInfo(res),
          contentRange: this.parseContentRangeHeader(res),
          arrayBuffer: () => res.arrayBuffer().then((buf) => new Uint8Array(buf)),
        }
      }),
    )
  }

  abort(): void {
    this.abortController.abort()
  }

  private toHeadInfo(res: Response): IHeadRequestInfo {
    const contentRange = this.parseContentRangeHeader(res)
    const contentLength = res.headers.get('Content-Length')
    const size = contentRange?.instanceLength ?? (contentLength ? Number(contentLength) : undefined)
    if (typeof size !== 'number') {
      throw new Error('Could not determine file size from HTTP response')
    }
    return {
      url: res.url,
      size,
      mimeType: res.headers.get('Content-Type') ?? undefined,
      // Hardcoded rather than detected from the Accept-Ranges header: this
      // client is only ever used against Drive's alt=media endpoint, which
      // reliably honors a Range header on an actual GET (streamProxy.ts's
      // playback path already depends on exactly this) — but its response
      // to a bare HEAD probe doesn't consistently include Accept-Ranges,
      // which made @tokenizer/range conclude the server rejects partial
      // requests and refuse to parse at all, confirmed in practice on a
      // real file ("Server does not accept partial requests" on ingest).
      acceptPartialRequests: true,
    }
  }

  private parseContentRangeHeader(res: Response): IContentRangeType | undefined {
    const header = res.headers.get('Content-Range')
    return header ? parseContentRange(header) : undefined
  }
}

async function parseTagsAndArt(url: string, headers: Record<string, string>): Promise<IAudioMetadata> {
  const client = new AuthenticatedRangeClient(url, headers)
  const tokenizer = await createRangeTokenizer(client)
  try {
    return await parseFromTokenizer(tokenizer)
  } finally {
    await tokenizer.close()
  }
}

function titleFallback(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/**
 * A single remote M4B file — chapters/duration via ffprobe-over-URL
 * (handles both chpl and QuickTime chapter-track styles, same as local),
 * tags/artwork via a range-tokenized music-metadata parse (only fetches
 * the byte ranges the MP4 box-walker actually needs, not the whole
 * file). Known v1 limitation, matching what relink.ts already accepts
 * for manually-browsed local picks: no multi-part "Part 1"/"Part 2"
 * grouping for remote books — each remote M4B file is its own book.
 */
export async function ingestRemoteM4b(
  url: string,
  headers: Record<string, string>,
  fileName: string,
  fileUri: string,
): Promise<IngestedBook> {
  const [containerInfo, tags] = await Promise.all([
    withDriveLimit(() => readContainerInfoFromUrl(url, headers)),
    parseTagsAndArt(url, headers),
  ])

  const title = tags.common.title || titleFallback(fileName)
  const chapters: IngestedChapter[] =
    containerInfo.chapters.length > 0
      ? containerInfo.chapters.map((c) => ({
          title: c.title,
          startTime: c.startTime,
          duration: c.endTime - c.startTime,
          filePath: fileUri,
        }))
      : [{ title, startTime: 0, duration: containerInfo.duration, filePath: fileUri }]

  return {
    title,
    author: tags.common.albumartist || tags.common.artist || null,
    seriesName: null,
    seriesNumber: tags.common.movementIndex?.no ? Number(tags.common.movementIndex.no) : null,
    narrator: narratorFrom(tags),
    chapters,
    artworkMetadata: tags,
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A chapter-per-file rip's own title tag typically repeats the book title
// verbatim (e.g. "17 - Going Postal: Chapter Fourteen: Deliverance") —
// redundant once every chapter already sits under the book's own title in
// the UI. Strips a leading track number, then (only if present) an exact,
// case-insensitive "<book title>:" prefix — safe because bookTitle is the
// caller's already-known folder name, not a guess, so this can't misfire
// into stripping something else entirely. Leaves the tag untouched if
// neither is present, rather than mangling an unrelated title shape.
function stripChapterTitleNoise(rawTitle: string, bookTitle: string): string {
  const withoutLeadingNumber = rawTitle.replace(/^\s*\d+\s*[-.:]?\s*/, '')
  const bookPrefixRe = new RegExp(`^${escapeRegExp(bookTitle)}\\s*:\\s*`, 'i')
  const withoutBookPrefix = withoutLeadingNumber.replace(bookPrefixRe, '')
  return withoutBookPrefix.trim() || rawTitle.trim()
}

export interface RemoteM4bPart {
  url: string
  headers: Record<string, string>
  fileName: string
  /** books.chapters.file_path equivalent for this part — gdrive://<fileId>. */
  fileUri: string
}

/**
 * A book split across several single-chapter-per-file M4B rips sitting in
 * the same Drive folder (e.g. "01 - Opening Credits.m4b" .. "19 - End
 * Credits.m4b", each with its own "<track> - <Book>: <Chapter>" title tag)
 * — the same folder-is-the-book convention ingestRemoteMp3Folder already
 * uses for loose MP3s, extended to M4B so these don't each become their own
 * separate book. Book title comes from the Drive folder name (`folderName`,
 * caller-supplied) rather than any per-part tag, since no single part's tag
 * is a reliable book title here — each one is chapter-specific.
 *
 * Sorted by embedded track tag then filename (numeric-aware), matching
 * ingestRemoteMp3Folder exactly. A part with its own embedded chapter
 * track (rare for this rip style, but matches local ingestM4b) expands to
 * multiple chapters instead of one; a generic embedded label ("Chapter 3")
 * is renumbered globally rather than kept as-is, same reasoning as
 * ingestM4b's isGenericChapterLabel handling.
 */
export async function ingestRemoteM4bParts(parts: RemoteM4bPart[], folderName: string): Promise<IngestedBook> {
  const parsed = await Promise.all(
    parts.map(async (part) => {
      const [containerInfo, tags] = await Promise.all([
        withDriveLimit(() => readContainerInfoFromUrl(part.url, part.headers)),
        parseTagsAndArt(part.url, part.headers),
      ])
      return { ...part, containerInfo, tags }
    }),
  )

  parsed.sort((a, b) => {
    const trackDiff = (a.tags.common.track?.no ?? Number.MAX_SAFE_INTEGER) - (b.tags.common.track?.no ?? Number.MAX_SAFE_INTEGER)
    if (trackDiff !== 0) return trackDiff
    return a.fileName.localeCompare(b.fileName, undefined, { numeric: true })
  })

  const chapters: IngestedChapter[] = []
  let globalChapterIndex = 0
  for (const { fileUri, fileName, containerInfo, tags } of parsed) {
    if (containerInfo.chapters.length > 0) {
      for (const c of containerInfo.chapters) {
        globalChapterIndex++
        const title = isGenericChapterLabel(c.title) ? `Chapter ${globalChapterIndex}` : c.title
        chapters.push({ title, startTime: c.startTime, duration: c.endTime - c.startTime, filePath: fileUri })
      }
    } else {
      globalChapterIndex++
      const rawTitle = tags.common.title || titleFallback(fileName)
      const cleaned = stripChapterTitleNoise(rawTitle, folderName)
      const title = isGenericChapterLabel(cleaned) ? `Chapter ${globalChapterIndex}` : cleaned
      chapters.push({ title, startTime: 0, duration: containerInfo.duration, filePath: fileUri })
    }
  }

  const first = parsed[0].tags

  return {
    title: folderName,
    author: first.common.albumartist || first.common.artist || null,
    seriesName: null,
    seriesNumber: null,
    narrator: narratorFrom(first),
    chapters,
    artworkMetadata: first,
  }
}

interface RemoteMp3File {
  fileId: string
  fileName: string
  url: string
  headers: Record<string, string>
}

/**
 * A folder of standalone remote MP3 files, one per chapter — mirrors
 * ingestMp3Folder's sort-by-track-then-filename assembly exactly, just
 * with each file's tags/duration coming from a range-tokenized parse
 * instead of a local parseFile() call.
 */
export async function ingestRemoteMp3Folder(folderName: string, files: RemoteMp3File[]): Promise<IngestedBook> {
  const parsed = await Promise.all(
    files.map(async (f) => {
      const metadata = await parseTagsAndArt(f.url, f.headers)
      return { fileName: f.fileName, fileId: f.fileId, metadata }
    }),
  )

  parsed.sort((a, b) => {
    const trackDiff = (a.metadata.common.track?.no ?? Number.MAX_SAFE_INTEGER) - (b.metadata.common.track?.no ?? Number.MAX_SAFE_INTEGER)
    if (trackDiff !== 0) return trackDiff
    return a.fileName.localeCompare(b.fileName, undefined, { numeric: true })
  })

  const chapters: IngestedChapter[] = parsed.map(({ fileName, fileId, metadata }) => ({
    title: metadata.common.title || titleFallback(fileName),
    startTime: 0,
    duration: metadata.format.duration ?? 0,
    filePath: `gdrive://${fileId}`,
  }))

  const first = parsed[0]?.metadata

  return {
    title: first?.common.album || folderName,
    author: first?.common.albumartist || first?.common.artist || null,
    seriesName: null,
    seriesNumber: null,
    narrator: narratorFrom(first),
    chapters,
    artworkMetadata: first!,
  }
}
