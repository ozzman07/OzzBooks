import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../db/index.js'
import type { BookRow, SourceRow } from '../types.js'
import { ingestMp3Folder, type IngestedBook, type IngestedChapter } from './mp3Folder.js'
import { ingestM4b, isDrmFile } from './m4b.js'
import { groupM4bParts, groupSiblingFolders } from './partGrouping.js'
import { contentHash } from './contentHash.js'
import { extractArtwork } from './artwork.js'
import { deriveSeriesNumberFromName } from './seriesNumber.js'
import { getProvider, getScanner } from '../integrations/remote/registry.js'

export interface Candidate {
  format: 'm4b' | 'mp3_folder'
  /** book-level path: the first (or only) .m4b file; for mp3_folder, the
   * folder itself (single-folder case) or the first sibling disc folder
   * in play order (multi-folder group case). */
  filePath: string
  hashInput: string // file used to compute the dedup content hash
  /** For m4b: every file that's part of this book, in play order — length
   * 1 in the common single-file case. For mp3_folder: every sibling disc
   * folder that's part of this book, in play order — undefined for a
   * standalone (non-grouped) mp3_folder candidate. */
  parts?: string[]
  /** Set only for a multi-folder mp3_folder group: the parent directory
   * containing the sibling disc folders (e.g. the "Book Title" folder
   * containing "Disc 1"/"Disc 2"). filePath/hashInput point one level
   * deeper (into the first disc folder) than the book's own folder, so
   * series-name derivation and local cover-art lookup need this instead.
   * Undefined everywhere else. */
  groupFolder?: string
}

// Folders used to stash the original files a book was combined/converted
// from (kept as a just-in-case backup, not meant to be part of the
// library). Two naming families found in the real library: "Source"/
// "source files"/"zzzSource files" (the one being adopted as the standard
// going forward — existing folders are being renamed to it gradually), and
// "To Delete" (found on the Dresden Files books — leftover duplicate .m4b
// files sitting in a "To Delete" subfolder alongside the real one, not yet
// cleaned up on the NAS). Deliberately whole-name-only so it doesn't catch
// real book titles that happen to contain one of these words as a
// substring, like "Sourcery" or "The Source of Magic".
export const BACKUP_FOLDER_RE = /^((zzz)?\s*sources?(\s+files?)?|to\s+delete)$/i

// .m4a and .m4b are the same MPEG-4/AAC container — Apple just uses .m4b as
// a convention for "this M4A has audiobook chapter markers," not a
// different format. Treated identically everywhere in this pipeline.
const M4B_EXTENSIONS = ['.m4b', '.m4a']
export function isM4bFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  return M4B_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export async function findCandidates(dir: string): Promise<Candidate[]> {
  if (BACKUP_FOLDER_RE.test(path.basename(dir))) return []

  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile())
  const dirs = entries.filter((e) => e.isDirectory())

  const drm = files.filter((f) => isDrmFile(f.name))
  for (const f of drm) {
    console.warn(`Skipping DRM-encumbered file (out of scope): ${path.join(dir, f.name)}`)
  }

  const m4bFiles = files.filter((f) => isM4bFile(f.name))
  const mp3Files = files.filter((f) => f.name.toLowerCase().endsWith('.mp3'))

  const candidates: Candidate[] = []

  // Some rips split one book across multiple M4B files (e.g. "Part 1"/
  // "Part 2") — groupM4bParts identifies those so they become one book
  // candidate with multiple chapters instead of one book per file.
  const { groups, singles } = groupM4bParts(m4bFiles.map((f) => f.name))
  for (const group of groups) {
    const parts = group.map((name) => path.join(dir, name))
    candidates.push({ format: 'm4b', filePath: parts[0], hashInput: parts[0], parts })
  }
  for (const name of singles) {
    const filePath = path.join(dir, name)
    candidates.push({ format: 'm4b', filePath, hashInput: filePath, parts: [filePath] })
  }

  if (m4bFiles.length === 0 && mp3Files.length > 0) {
    candidates.push({
      format: 'mp3_folder',
      filePath: dir,
      hashInput: path.join(dir, mp3Files[0].name),
    })
  }

  // Some MP3-folder rips split one book across sibling folders instead of
  // multiple files in one folder (e.g. "Disc 1"/"Disc 2"/"Disc 3") —
  // groupSiblingFolders identifies those the same way groupM4bParts
  // identifies multi-part M4B filenames, just applied to directory names.
  // All-or-nothing: every folder in a matched name-group must
  // independently qualify (has mp3s, no m4b) or the whole group is
  // rejected and its folders fall through to ordinary per-folder
  // recursion below — never a partial group.
  const claimedDirNames = new Set<string>()
  const { groups: siblingGroups } = groupSiblingFolders(dirs.map((d) => d.name))
  for (const group of siblingGroups) {
    const validated = await Promise.all(
      group.map(async (name) => {
        const subDir = path.join(dir, name)
        const subEntries = await readdir(subDir, { withFileTypes: true })
        const subFiles = subEntries.filter((e) => e.isFile())
        const hasM4b = subFiles.some((f) => isM4bFile(f.name))
        const mp3s = subFiles.filter((f) => f.name.toLowerCase().endsWith('.mp3'))
        return { name, subDir, mp3s, ok: !hasM4b && mp3s.length > 0 }
      }),
    )
    if (!validated.every((v) => v.ok)) continue

    const parts = validated.map((v) => v.subDir)
    candidates.push({
      format: 'mp3_folder',
      filePath: parts[0],
      hashInput: path.join(parts[0], validated[0].mp3s[0].name),
      parts,
      groupFolder: dir,
    })
    for (const name of group) claimedDirNames.add(name)
  }

  // Always recurse into subdirectories to support Author/Series/Book
  // nesting — including when this folder *also* has loose audio files
  // directly in it (e.g. a standalone short story .m4b sitting alongside a
  // series' own book subfolders). Previously this only recursed when the
  // folder had zero direct audio files, which silently skipped every
  // subdirectory whenever any loose file was present alongside them — the
  // real cause of whole series going missing from the index (found via a
  // folder with one loose novella file plus 21 book subfolders, all 21 of
  // which were never being scanned at all). Folders already claimed by a
  // sibling group above are skipped here — they're accounted for as part
  // of that one grouped candidate, not scanned individually.
  for (const d of dirs) {
    if (claimedDirNames.has(d.name)) continue
    candidates.push(...(await findCandidates(path.join(dir, d.name))))
  }

  return candidates
}

// A handful of top-level author folders on the NAS carry garbled 8.3-style
// short names (e.g. "WO3RF0~1") from some historical file transfer — the
// real folder name isn't reliably recoverable, so those fall back to
// whatever the embedded metadata tag says instead of trusting the folder.
const GARBLED_FOLDER_NAME_RE = /^[A-Z0-9]{6}~[A-Z0-9]$/

/**
 * The user organizes the library as one folder per author directly under
 * the source root (e.g. "Audio Books/Clarke, Arthur C/..."), which is far
 * more consistent than embedded artist/albumartist tags — those are a mix
 * of "First Last", already-inverted "Last, First", compilation-folder
 * names, missing values, and other tagging noise (see the "-"/"Top 100
 * Sci-Fi Books" cases this was built to fix). Returns null (meaning: fall
 * back to the tag-derived author) when there's no author-folder level to
 * read from, or when it's one of the garbled short names above.
 */
/**
 * The segment-array core, extracted so a remote source (Drive's
 * parents-based folder hierarchy, no real path string to split) can
 * reuse the exact same derivation logic — it just builds its own segment
 * array by walking folder names up to the source root, instead of
 * splitting a filesystem path. Local behavior below is unchanged.
 */
export function deriveAuthorFromSegments(segments: string[]): string | null {
  const [authorFolder, ...rest] = segments
  if (rest.length === 0) return null // file/folder sits directly at the source root, no author level
  if (!authorFolder || GARBLED_FOLDER_NAME_RE.test(authorFolder)) return null
  return authorFolder
}

function deriveAuthorFromFolder(pathScope: string, filePath: string): string | null {
  const relative = path.relative(pathScope, filePath)
  return deriveAuthorFromSegments(relative.split(path.sep))
}

/**
 * Same idea as deriveAuthorFromFolder, one level down: when a book's own
 * folder sits inside an extra layer between it and the author folder (e.g.
 * "Butcher, Jim/The Dresden Files/The Dresden Files 01.0 - Storm Front/"),
 * that middle folder is a reliable series name for the vast majority of
 * this library's series.
 *
 * Two segment counts matter:
 *  - 3+ segments (author/series-folder/book-folder): the folder above the
 *    book's own folder is always the series, regardless of how many other
 *    books share it — a "series" folder holding just one book-folder today
 *    still reads as a series (e.g. a first entry added before its sequel).
 *  - Exactly 2 segments (author/folder-with-file-directly-inside, no
 *    separate book folder): ambiguous from the path alone — this could be
 *    a series folder with several books sitting flat inside it, or just
 *    one standalone book's own wrapper folder. siblingBookCount (how many
 *    other candidates share this exact folder, passed in by the caller
 *    from a full-source scan) breaks the tie: more than one sibling means
 *    treat the folder as the series name; exactly one means it's just that
 *    book's own folder, not a series.
 * Returns null for books that sit directly under their author folder with
 * no folder layer at all (0-1 segments).
 *
 * Known imperfection, accepted for now: a deep "collected works" folder
 * (e.g. "Brandon Sanderson Cosmere Collection" containing Mistborn,
 * Elantris, Stormlight Archive, etc. each in their own subfolder) reads as
 * one broad "series" rather than each actual sub-series — a future
 * LLM-assisted pass would be needed to disambiguate this.
 */
/** Segment-array core — see deriveAuthorFromSegments's docstring above,
 * same reasoning applies here. siblingBookCount defaults to 1 (no
 * promotion) for callers with no full-scan sibling context, e.g. a single-
 * candidate relink. */
export function deriveSeriesFromSegments(segments: string[], siblingBookCount = 1): string | null {
  if (segments.length < 2) return null // directly under the author folder — no folder layer at all
  if (segments.length === 2) {
    if (siblingBookCount < 2) return null // just this one book's own wrapper folder, not a series
    const seriesFolder = segments[1]
    if (!seriesFolder || GARBLED_FOLDER_NAME_RE.test(seriesFolder)) return null
    return seriesFolder
  }
  const seriesFolder = segments[segments.length - 2]
  if (!seriesFolder || GARBLED_FOLDER_NAME_RE.test(seriesFolder)) return null
  return seriesFolder
}

function deriveSeriesFromFolder(pathScope: string, bookOwnFolder: string, siblingBookCount = 1): string | null {
  const relative = path.relative(pathScope, bookOwnFolder)
  return deriveSeriesFromSegments(relative.split(path.sep), siblingBookCount)
}

/** The folder that directly contains a book's audio — its own dedicated
 * folder for a multi-part group, or (for a single file) the folder the
 * file happens to sit in, which the caller doesn't yet know is the book's
 * own folder or a flat series folder shared with siblings. Extracted so
 * both applyIngestedCandidate and the sibling-counting pass in scanSource
 * compute this identically. */
export function resolveBookOwnFolder(candidate: Candidate): string {
  return candidate.groupFolder ?? (candidate.format === 'mp3_folder' ? candidate.filePath : path.dirname(candidate.filePath))
}

/** Counts, per book-own-folder (relative to the source root), how many
 * scan candidates share it — the signal deriveSeriesFromSegments needs to
 * tell a flat series folder (multiple books sharing it) apart from a
 * standalone book's own wrapper folder (exactly one). Built once per scan
 * from the full candidate list, then looked up per-candidate. */
export function buildSeriesSiblingCounts(source: SourceRow, candidates: Candidate[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    const relative = path.relative(source.path_scope, resolveBookOwnFolder(candidate))
    counts.set(relative, (counts.get(relative) ?? 0) + 1)
  }
  return counts
}

export async function ingestCandidate(candidate: Candidate): Promise<IngestedBook> {
  if (candidate.format === 'm4b') {
    return ingestM4b(candidate.parts ?? [candidate.filePath])
  }
  const folders = candidate.parts ?? [candidate.filePath]
  const parts = await Promise.all(
    folders.map(async (dirPath) => {
      const entries = await readdir(dirPath, { withFileTypes: true })
      const mp3Filenames = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.mp3'))
        .map((e) => e.name)
      return { dirPath, mp3Filenames }
    }),
  )
  return ingestMp3Folder(parts)
}

export interface ScanResult {
  found: number
  created: number
  updated: number
  markedMissing: number
  skippedDuplicates: number
  failed: number
}

/**
 * Applies one parsed candidate to the books/chapters tables: derives
 * author/series from folder structure, extracts artwork, and upserts the
 * book row. Passing existingBookId keeps the same book id on update —
 * used both for a normal rescan match and for a content-hash relink match
 * (see scanSource) or a manual relink confirm, all of which must preserve
 * the book id so cloud-synced progress/bookmarks/downloads (keyed by book
 * id) stay intact across a file move.
 */
export interface ResolvedBook {
  filePath: string
  format: 'm4b' | 'mp3_folder'
  title: string
  author: string | null
  seriesName: string | null
  seriesNumber: number | null
  seriesNumberSource: 'tag' | 'folder' | 'manual' | null
  artworkThumbPath: string | null
  artworkFullPath: string | null
  contentHash: string
  chapters: IngestedChapter[]
}

/**
 * The actual DB write (upsert + chapter replace), decoupled from local
 * parsing/derivation — this is the part remote sources reuse directly
 * (see integrations/remote/googleDrive/remoteScan.ts), since their
 * author/series derivation and metadata parsing use entirely different
 * mechanics (Drive's parents-based folder hierarchy, ffprobe-over-URL)
 * than the local-filesystem-path logic in applyIngestedCandidate below.
 */
export function writeBookAndChapters(
  source: SourceRow,
  bookId: string,
  created: boolean,
  resolved: ResolvedBook,
): { bookId: string; created: boolean } {
  const db = getDb()

  const upsert = db.prepare(`
    INSERT INTO books (
      id, source_id, file_path, format, title, author, series_name, series_number, series_number_source,
      status, artwork_thumb_path, artwork_full_path, content_hash, created_at, updated_at
    ) VALUES (@id, @source_id, @file_path, @format, @title, @author, @series_name, @series_number, @series_number_source,
      'active', @artwork_thumb_path, @artwork_full_path, @content_hash, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      format = excluded.format,
      title = excluded.title,
      author = excluded.author,
      series_name = excluded.series_name,
      series_number = excluded.series_number,
      series_number_source = excluded.series_number_source,
      status = 'active',
      artwork_thumb_path = excluded.artwork_thumb_path,
      artwork_full_path = excluded.artwork_full_path,
      content_hash = excluded.content_hash,
      updated_at = datetime('now')
      -- created_at deliberately not touched on conflict — set once at
      -- first insert, preserved across every rescan after that. file_path
      -- and format ARE updated on conflict (unlike a plain per-path match)
      -- so a content-hash relink match can move the row to its new path
      -- instead of the move being silently ignored.
  `)

  upsert.run({
    id: bookId,
    source_id: source.id,
    file_path: resolved.filePath,
    format: resolved.format,
    title: resolved.title,
    author: resolved.author,
    series_name: resolved.seriesName,
    series_number: resolved.seriesNumber,
    series_number_source: resolved.seriesNumberSource,
    artwork_thumb_path: resolved.artworkThumbPath,
    artwork_full_path: resolved.artworkFullPath,
    content_hash: resolved.contentHash,
  })

  db.prepare('DELETE FROM chapters WHERE book_id = ?').run(bookId)
  const insertChapter = db.prepare(`
    INSERT INTO chapters (id, book_id, idx, title, start_time, duration, file_path)
    VALUES (@id, @book_id, @idx, @title, @start_time, @duration, @file_path)
  `)
  resolved.chapters.forEach((chapter, idx) => {
    insertChapter.run({
      id: randomUUID(),
      book_id: bookId,
      idx,
      title: chapter.title,
      start_time: chapter.startTime,
      duration: chapter.duration,
      file_path: chapter.filePath,
    })
  })

  return { bookId, created }
}

/** series_number's one exception to the "folder always wins, recomputed
 * fresh every scan" rule author/series_name both follow: once a user has
 * manually corrected it, that value must survive every future rescan
 * rather than being silently overwritten by a fresh folder guess. */
function resolveSeriesNumber(
  existingBookId: string | undefined,
  seriesName: string | null,
  bookOwnFolder: string,
  candidateFilePath: string,
  taggedSeriesNumber: number | null,
): { seriesNumber: number | null; seriesNumberSource: 'tag' | 'folder' | 'manual' | null } {
  if (existingBookId) {
    const existing = getDb()
      .prepare('SELECT series_number, series_number_source FROM books WHERE id = ?')
      .get(existingBookId) as { series_number: number | null; series_number_source: string | null } | undefined
    if (existing?.series_number_source === 'manual') {
      return { seriesNumber: existing.series_number, seriesNumberSource: 'manual' }
    }
  }

  if (seriesName) {
    const folderGuess =
      deriveSeriesNumberFromName(seriesName, path.basename(bookOwnFolder)) ??
      deriveSeriesNumberFromName(seriesName, path.basename(candidateFilePath, path.extname(candidateFilePath)))
    if (folderGuess !== null) {
      return { seriesNumber: folderGuess, seriesNumberSource: 'folder' }
    }
  }

  if (taggedSeriesNumber !== null) {
    return { seriesNumber: taggedSeriesNumber, seriesNumberSource: 'tag' }
  }

  return { seriesNumber: null, seriesNumberSource: null }
}

export async function applyIngestedCandidate(
  source: SourceRow,
  candidate: Candidate,
  existingBookId: string | undefined,
  hash: string,
  seriesSiblingCounts?: Map<string, number>,
): Promise<{ bookId: string; created: boolean }> {
  const ingested = await ingestCandidate(candidate)
  const author = deriveAuthorFromFolder(source.path_scope, candidate.filePath) ?? ingested.author
  // groupFolder (set only for a multi-folder mp3_folder group) is the
  // book's own folder; filePath/hashInput point one level deeper, into the
  // first disc subfolder, which would otherwise misread as an extra path
  // segment for series derivation and miss a parent-folder cover.jpg.
  const bookOwnFolder = resolveBookOwnFolder(candidate)
  const siblingBookCount = seriesSiblingCounts?.get(path.relative(source.path_scope, bookOwnFolder)) ?? 1
  const seriesName = deriveSeriesFromFolder(source.path_scope, bookOwnFolder, siblingBookCount)
  const { seriesNumber, seriesNumberSource } = resolveSeriesNumber(
    existingBookId,
    seriesName,
    bookOwnFolder,
    candidate.filePath,
    ingested.seriesNumber,
  )
  const bookId = existingBookId ?? randomUUID()
  const artwork = await extractArtwork(
    bookId,
    candidate.groupFolder ?? path.dirname(candidate.hashInput),
    ingested.artworkMetadata,
  )

  return writeBookAndChapters(source, bookId, !existingBookId, {
    filePath: candidate.filePath,
    format: candidate.format,
    title: ingested.title,
    author,
    seriesName,
    seriesNumber,
    seriesNumberSource,
    artworkThumbPath: artwork?.thumbPath ?? null,
    artworkFullPath: artwork?.fullPath ?? null,
    contentHash: hash,
    chapters: ingested.chapters,
  })
}

export async function scanSource(source: SourceRow): Promise<ScanResult> {
  const db = getDb()

  // A source with a non-local type delegates to whatever provider/scanner
  // is registered for it (see integrations/remote/registry.ts) — Google
  // Drive registers both at server startup. If either is missing, fails
  // the scan cleanly (clear scan_issues message) rather than crashing
  // (findCandidates would throw on a non-filesystem path_scope) or
  // silently doing nothing. Local/Synology scanning below is completely
  // unaffected either way.
  if (source.type !== 'local' && source.type !== 'synology') {
    const provider = getProvider(source.type)
    const scanner = getScanner(source.type)

    if (provider && scanner) {
      return scanner(source, provider)
    }

    const message = provider
      ? `Remote scanning for source type "${source.type}" is not implemented yet`
      : `No provider registered for source type "${source.type}" yet`

    db.prepare('DELETE FROM scan_issues WHERE source_id = ?').run(source.id)
    db.prepare('INSERT INTO scan_issues (id, source_id, file_path, error) VALUES (?, ?, ?, ?)').run(
      randomUUID(),
      source.id,
      source.path_scope,
      message,
    )
    const result: ScanResult = { found: 0, created: 0, updated: 0, markedMissing: 0, skippedDuplicates: 0, failed: 1 }
    db.prepare(
      `UPDATE sources SET
         last_scanned_at = datetime('now'),
         last_scan_found = ?, last_scan_created = ?, last_scan_updated = ?,
         last_scan_failed = ?, last_scan_skipped_duplicates = ?
       WHERE id = ?`,
    ).run(result.found, result.created, result.updated, result.failed, result.skippedDuplicates, source.id)
    return result
  }

  const candidates = await findCandidates(source.path_scope)
  const seriesSiblingCounts = buildSeriesSiblingCounts(source, candidates)

  const result: ScanResult = {
    found: candidates.length,
    created: 0,
    updated: 0,
    markedMissing: 0,
    skippedDuplicates: 0,
    failed: 0,
  }
  const seenFilePaths = new Set<string>()

  // Issues reflect the current scan only — clear stale ones from last time
  // so a fixed file drops off the list instead of lingering forever.
  db.prepare('DELETE FROM scan_issues WHERE source_id = ?').run(source.id)

  for (const candidate of candidates) {
    seenFilePaths.add(candidate.filePath)

    try {
      const hash = await contentHash(candidate.hashInput)

      let existing = db
        .prepare<[string, string], BookRow>('SELECT * FROM books WHERE source_id = ? AND file_path = ?')
        .get(source.id, candidate.filePath)

      if (!existing) {
        const duplicate = db
          .prepare<[string, string], BookRow>('SELECT * FROM books WHERE content_hash = ? AND source_id != ?')
          .get(hash, source.id)
        if (duplicate) {
          result.skippedDuplicates++
          continue
        }

        // Same-source hash match: this file is a previously-indexed book
        // that moved (folder rename/reorganization), not a new book.
        // Matches regardless of current status ('active' or already
        // 'missing' from an earlier scan) — without this, a same-source
        // move orphans the old row as missing and creates a duplicate at
        // the new path, silently resetting progress/bookmarks/downloads.
        // Excludes rows already claimed by another file processed earlier
        // in this same scan, guarding against genuine intra-library
        // duplicates confusing the match.
        const relinkMatch = db
          .prepare<[string, string, string], BookRow>(
            'SELECT * FROM books WHERE source_id = ? AND content_hash = ? AND file_path != ?',
          )
          .get(source.id, hash, candidate.filePath)
        if (relinkMatch && !seenFilePaths.has(relinkMatch.file_path)) {
          existing = relinkMatch
        }
      }

      const { created } = await applyIngestedCandidate(source, candidate, existing?.id, hash, seriesSiblingCounts)
      if (created) result.created++
      else result.updated++
    } catch (err) {
      // A single unreadable/corrupt file (e.g. a truncated M4B with no moov
      // atom) shouldn't abort ingestion for the rest of the library — log
      // and move on. The file stays out of seenFilePaths-driven "missing"
      // marking since it's already added above; it just isn't ingested.
      console.warn(`Skipping unreadable/corrupt file during scan: ${candidate.filePath}`, err)
      result.failed++
      db.prepare(
        'INSERT INTO scan_issues (id, source_id, file_path, error) VALUES (?, ?, ?, ?)',
      ).run(randomUUID(), source.id, candidate.filePath, String(err))
    }
  }

  // Anything previously indexed under this source but not found this scan
  // is marked missing, never deleted — progress/bookmarks/downloads live
  // in the separate cloud sync layer and are keyed off book_id, which
  // stays stable.
  const previouslyActive = db
    .prepare<[string], BookRow>("SELECT * FROM books WHERE source_id = ? AND status = 'active'")
    .all(source.id)
  for (const book of previouslyActive) {
    if (!seenFilePaths.has(book.file_path)) {
      db.prepare("UPDATE books SET status = 'missing', updated_at = datetime('now') WHERE id = ?").run(book.id)
      result.markedMissing++
    }
  }

  db.prepare(
    `UPDATE sources SET
       last_scanned_at = datetime('now'),
       last_scan_found = ?,
       last_scan_created = ?,
       last_scan_updated = ?,
       last_scan_failed = ?,
       last_scan_skipped_duplicates = ?
     WHERE id = ?`,
  ).run(result.found, result.created, result.updated, result.failed, result.skippedDuplicates, source.id)

  return result
}
