import path from 'node:path'
import { parseFile } from 'music-metadata'
import { readContainerInfo } from './ffprobe.js'
import type { IngestedBook, IngestedChapter } from './mp3Folder.js'

const DRM_EXTENSIONS = new Set(['.aax', '.aaxc'])

export function isDrmFile(filePath: string): boolean {
  return DRM_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * A single M4B file. Chapters come from ffprobe (handles both Nero-style
 * and QuickTime chapter-track M4B variants); if the file has none, the
 * whole file becomes one chapter.
 */
export async function ingestM4b(filePath: string): Promise<IngestedBook> {
  const [metadata, containerInfo] = await Promise.all([parseFile(filePath), readContainerInfo(filePath)])

  const duration = containerInfo.duration || metadata.format.duration || 0

  const chapters: IngestedChapter[] =
    containerInfo.chapters.length > 0
      ? containerInfo.chapters.map((c) => ({
          title: c.title,
          startTime: c.startTime,
          duration: c.endTime - c.startTime,
          filePath,
        }))
      : [{ title: metadata.common.title || path.basename(filePath, path.extname(filePath)), startTime: 0, duration, filePath }]

  return {
    title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
    author: metadata.common.albumartist || metadata.common.artist || null,
    seriesName: null,
    seriesNumber: metadata.common.movementIndex?.no
      ? Number(metadata.common.movementIndex.no)
      : null,
    chapters,
    artworkMetadata: metadata,
  }
}
