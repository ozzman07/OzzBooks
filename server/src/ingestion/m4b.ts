import path from 'node:path'
import { parseFile } from 'music-metadata'
import { readContainerInfo } from './ffprobe.js'
import type { IngestedBook, IngestedChapter } from './mp3Folder.js'
import { PART_MARKER_RE, BARE_TRAILING_NUMBER_RE } from './partGrouping.js'

const DRM_EXTENSIONS = new Set(['.aax', '.aaxc'])

export function isDrmFile(filePath: string): boolean {
  return DRM_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function titleFallback(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
}

// Some rips have embedded "chapters" that are really just auto-generated
// fixed-length segments (e.g. every 5 minutes) labeled "Part 1", "Part 2", …
// — not meaningful chapter titles, and the numbering restarts from 1 in
// each file. Prefixing those with our own outer "Part N:" label produces
// nonsense like "Part 1: Part 1", and the restart makes chapter titles
// collide across parts. Detect this and fall back to clean sequential
// numbering across the whole merged book instead.
const GENERIC_CHAPTER_RE = /^(?:chapter|part|track|segment)\s*\d+\.?$/i

function isGenericChapterLabel(title: string): boolean {
  return GENERIC_CHAPTER_RE.test(title.trim())
}

/**
 * A book split across multiple M4B files (e.g. "Part 1"/"Part 2", or a
 * bare trailing-number scheme — see partGrouping.ts) is really one book:
 * embedded chapters from every part are concatenated in part order, each
 * still pointing at its own part's filePath/startTime, matching the
 * existing MP3-folder model of "one chapter, one file, own offset". A
 * part with no embedded chapters of its own becomes a single "Part N"
 * chapter, same fallback as the single-file case below.
 *
 * `filePaths` has length 1 for the overwhelming common case of a book
 * that's just one M4B file — that path is unchanged from before this
 * multi-part support was added.
 */
export async function ingestM4b(filePaths: string[]): Promise<IngestedBook> {
  const parts = await Promise.all(
    filePaths.map(async (filePath) => {
      const [metadata, containerInfo] = await Promise.all([parseFile(filePath), readContainerInfo(filePath)])
      return { filePath, metadata, containerInfo }
    }),
  )

  const isMultiPart = parts.length > 1
  const chapters: IngestedChapter[] = []
  let globalChapterIndex = 0

  parts.forEach(({ filePath, metadata, containerInfo }, index) => {
    const duration = containerInfo.duration || metadata.format.duration || 0
    const partLabel = `Part ${index + 1}`

    if (containerInfo.chapters.length > 0) {
      for (const c of containerInfo.chapters) {
        globalChapterIndex++
        let title = c.title
        if (isMultiPart) {
          title = isGenericChapterLabel(c.title) ? `Chapter ${globalChapterIndex}` : `${partLabel}: ${c.title}`
        }
        chapters.push({
          title,
          startTime: c.startTime,
          duration: c.endTime - c.startTime,
          filePath,
        })
      }
    } else {
      chapters.push({
        title: isMultiPart ? partLabel : metadata.common.title || titleFallback(filePath),
        startTime: 0,
        duration,
        filePath,
      })
    }
  })

  const first = parts[0].metadata
  // For a multi-part book, strip a trailing "Part 1"/"Pt 1"/etc marker off
  // the first part's title so the book itself isn't named "..., Part 1" —
  // falls back to the album tag, then the bare filename, if that leaves
  // nothing usable.
  const firstPartTitle = first.common.title || titleFallback(filePaths[0])
  const keywordStripped = firstPartTitle.replace(PART_MARKER_RE, '$1').trim()
  const strippedTitle =
    keywordStripped !== firstPartTitle ? keywordStripped : firstPartTitle.replace(BARE_TRAILING_NUMBER_RE, '$1').trim()
  const title = isMultiPart ? first.common.album || strippedTitle || firstPartTitle : firstPartTitle

  return {
    title,
    author: first.common.albumartist || first.common.artist || null,
    seriesName: null,
    seriesNumber: first.common.movementIndex?.no ? Number(first.common.movementIndex.no) : null,
    chapters,
    artworkMetadata: first,
  }
}
