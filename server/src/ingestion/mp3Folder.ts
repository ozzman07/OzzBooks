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

/**
 * A directory of standalone MP3 files, one per chapter. Order comes from
 * the ID3 track-number tag when present, otherwise filename sort — matches
 * how most MP3-folder audiobook rips are laid out.
 */
export async function ingestMp3Folder(dirPath: string, mp3Filenames: string[]): Promise<IngestedBook> {
  const files = [...mp3Filenames].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const parsed = await Promise.all(
    files.map(async (filename) => {
      const filePath = path.join(dirPath, filename)
      const metadata = await parseFile(filePath)
      return { filename, filePath, metadata }
    }),
  )

  parsed.sort((a, b) => {
    const trackDiff = trackNumber(a.metadata) - trackNumber(b.metadata)
    if (trackDiff !== 0) return trackDiff
    return a.filename.localeCompare(b.filename, undefined, { numeric: true })
  })

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
  const folderName = path.basename(dirPath)

  return {
    title: first?.common.album || folderName,
    author: first?.common.albumartist || first?.common.artist || null,
    seriesName: null,
    seriesNumber: null,
    chapters,
    artworkMetadata: first!,
  }
}
