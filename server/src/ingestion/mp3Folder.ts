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
  /** Audiobook narrator — read from the ID3/MP4 "composer" tag, the
   * conventional (if inconsistent) place audiobook tools store this. Not a
   * real composer credit; there's no dedicated narrator tag in either
   * format's spec. Null when the tag's missing or blank, which real-world
   * files frequently are — confirmed against this library's own files
   * (2026-08-16): present and correct on some ("MacLeod Andrews", "Tim
   * Gerard Reynolds"), blank on others, absent entirely on plain MP3s. */
  narrator: string | null
  chapters: IngestedChapter[]
  /** Metadata to pull embedded cover art from — first chapter's tags. */
  artworkMetadata: IAudioMetadata
}

// Composer tag is sometimes present but blank ([""]) rather than absent —
// seen on real files in this library — so a plain join isn't enough; empty
// entries need filtering before deciding there's nothing usable.
export function narratorFrom(metadata: IAudioMetadata | undefined): string | null {
  const composer = metadata?.common.composer?.map((c) => c.trim()).filter(Boolean)
  return composer && composer.length > 0 ? composer.join(', ') : null
}

function trackNumber(metadata: IAudioMetadata): number {
  return metadata.common.track?.no ?? Number.MAX_SAFE_INTEGER
}

// Real case found in this library: a Graphic Audio rip (Judge Dredd
// "Wanted Dredd Or Alive" and "Death Trap") has its Album tag set to that
// file's own duration in MM.SS form ("18.50" for 18m50s) instead of a real
// album/book name — presumably whatever ripped these wrote duration into
// the wrong field. A real album name is never shaped like exactly 1-3
// digits, a literal dot, then exactly 2 digits, so this is safe to treat as
// "no album tag" (falls back to the folder name) rather than trust it as
// the book title. Exported so scan.ts's readAlbumTag can apply the same
// check when deciding whether files share an album for grouping purposes.
const DURATION_LIKE_TAG_RE = /^\d{1,3}\.\d{2}$/

export function isDurationLikeTag(value: string | null | undefined): boolean {
  return DURATION_LIKE_TAG_RE.test((value ?? '').trim())
}

// Same real files' Artist tag is a bare "." rather than a real name or
// being left blank — a placeholder the ripping tool wrote instead of
// leaving the field empty. Any tag with no letters or digits at all is
// junk, not a real (if unusual) name — reject it the same way a blank tag
// is already rejected, rather than surface "." as the author.
export function isJunkNameTag(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim()
  return trimmed !== '' && !/[a-zA-Z0-9]/.test(trimmed)
}

// Another real case in this library: one straggler track in an otherwise
// correctly-tagged Graphic Audio multi-disc rip (JLA: Exterminators) has
// Album "Unknown Album (19/06/2008 20:11:26)" and Artist "Unknown Artist" —
// the classic CDDB/freedb-lookup-failed placeholder an older ripping tool
// (e.g. EAC) writes when it can't identify the disc, timestamp and all,
// instead of leaving the field blank. Also reused by epub.ts for the same
// shape of problem on ebooks: a bare "Unknown" or "Unknown Author"
// <dc:creator> (6 real books in this library) — generalized to "unknown"
// plus at most one more word, plus an optional trailing parenthetical
// (the rip-timestamp case), so it still catches whichever noun/suffix a
// given tool appends without also rejecting a real name that merely
// starts with the word "Unknown" (e.g. "The Unknown Soldier" doesn't
// start with "unknown" at all, so it's untouched).
const PLACEHOLDER_TAG_RE = /^unknown(\s+\w+)?(\s*\(.*\))?$/i

export function isPlaceholderTag(value: string | null | undefined): boolean {
  return PLACEHOLDER_TAG_RE.test((value ?? '').trim())
}

function cleanAlbum(value: string | undefined): string | undefined {
  return value && !isDurationLikeTag(value) && !isPlaceholderTag(value) ? value : undefined
}

function cleanName(value: string | undefined): string | undefined {
  return value && !isJunkNameTag(value) && !isPlaceholderTag(value) ? value : undefined
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
    title: cleanAlbum(first?.common.album) || folderName,
    author: cleanName(first?.common.albumartist) || cleanName(first?.common.artist) || null,
    seriesName: null,
    seriesNumber: null,
    narrator: narratorFrom(first),
    chapters,
    artworkMetadata: first!,
  }
}
