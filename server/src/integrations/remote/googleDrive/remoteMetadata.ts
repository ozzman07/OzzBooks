import { tokenizer as createRangeTokenizer, parseContentRange } from '@tokenizer/range'
import type { IRangeRequestClient, IHeadRequestInfo, IRangeRequestResponse, IContentRangeType } from '@tokenizer/range'
import { parseFromTokenizer } from 'music-metadata'
import type { IAudioMetadata } from 'music-metadata'
import { readContainerInfoFromUrl } from '../../../ingestion/ffprobe.js'
import type { IngestedBook, IngestedChapter } from '../../../ingestion/mp3Folder.js'

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
    const res = await fetch(this.url, { method: 'HEAD', headers: this.headers, signal: this.abortController.signal })
    return this.toHeadInfo(res)
  }

  async getResponse(method: string, range?: [number, number]): Promise<IRangeRequestResponse> {
    const headers = { ...this.headers }
    if (range) headers.Range = `bytes=${range[0]}-${range[1]}`
    const res = await fetch(this.url, { method, headers, signal: this.abortController.signal })
    if (!res.ok) {
      throw new Error(`Unexpected HTTP response status=${res.status}`)
    }
    return {
      ...this.toHeadInfo(res),
      contentRange: this.parseContentRangeHeader(res),
      arrayBuffer: () => res.arrayBuffer().then((buf) => new Uint8Array(buf)),
    }
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
    const acceptRanges = res.headers.get('Accept-Ranges')
    return {
      url: res.url,
      size,
      mimeType: res.headers.get('Content-Type') ?? undefined,
      acceptPartialRequests: acceptRanges?.trim().toLowerCase() === 'bytes',
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
    readContainerInfoFromUrl(url, headers),
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
    chapters,
    artworkMetadata: tags,
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
    chapters,
    artworkMetadata: first!,
  }
}
