import path from 'node:path'
import { parseFile } from 'music-metadata'
import type { IAudioMetadata } from 'music-metadata'

export interface IngestedChapter {
  title: string
  startTime: number
  duration: number
  filePath: string
}

export interface IngestedBook {
  title: string
  author: string | null
  seriesName: string | null
  seriesNumber: number | null
  chapters: IngestedChapter[]
  /** Metadata to pull embedded cover art from — first chapter's tags. */
  artworkMetadata: IAudioMetadata
}

function trackNumber(metadata: IAudioMetadata): number {
  return metadata.common.track?.no ?? Number.MAX_SAFE_INTEGER
}

export interface Mp3FolderPart {
  dirPath: string
  mp3Filenames: string[]
}

async function parsePart(part: Mp3FolderPart) {
  const files = [...part.mp3Filenames].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const parsed = await Promise.all(
    files.map(async (filename) => {
      const filePath = path.join(part.dirPath, filename)
      const metadata = await parseFile(filePath)
      return { filename, filePath, metadata }
    }),
  )

  // Ordered within this one folder only — track-number tags frequently
  // restart at 1 per disc, so this sort must never be applied across
  // folders (see ingestMp3Folder below).
  parsed.sort((a, b) => {
    const trackDiff = trackNumber(a.metadata) - trackNumber(b.metadata)
    if (trackDiff !== 0) return trackDiff
    return a.filename.localeCompare(b.filename, undefined, { numeric: true })
  })

  return parsed
}

/**
 * One or more directories of standalone MP3 files, one file per chapter —
 * `parts` is a single-entry array for an ordinary mp3_folder book, or
 * multiple entries (in disc/part play order) for a book split across
 * sibling folders (e.g. "Disc 1"/"Disc 2"). Order within each part comes
 * from the ID3 track-number tag when present, otherwise filename sort —
 * matches how most MP3-folder audiobook rips are laid out. Parts are
 * concatenated in the given array order, never re-sorted together
 * globally, since cross-disc track numbers are frequently non-monotonic
 * (many rips restart at track 1 on every disc).
 */
export async function ingestMp3Folder(parts: Mp3FolderPart[]): Promise<IngestedBook> {
  const parsedParts = await Promise.all(parts.map(parsePart))
  const parsed = parsedParts.flat()

  // start_time is always 0 here: each chapter is its own standalone file
  // (unlike M4B, where multiple chapters share one file and start_time is
  // a real offset into it). Streaming is always "play this chapter's
  // file_path from its start_time," so this keeps the two formats
  // consistent for the client.
  const chapters: IngestedChapter[] = parsed.map(({ filename, filePath, metadata }) => ({
    title: metadata.common.title || path.basename(filename, path.extname(filename)),
    startTime: 0,
    duration: metadata.format.duration ?? 0,
    filePath,
  }))

  const first = parsed[0]?.metadata
  // A single folder's own name is the book title (today's behavior,
  // unchanged); for a multi-disc group, the discs' shared PARENT folder is
  // the book title instead — "Disc 1" itself would be wrong.
  const folderName =
    parts.length > 1 ? path.basename(path.dirname(parts[0].dirPath)) : path.basename(parts[0].dirPath)

  return {
    title: first?.common.album || folderName,
    author: first?.common.albumartist || first?.common.artist || null,
    seriesName: null,
    seriesNumber: null,
    chapters,
    artworkMetadata: first!,
  }
}
