import { randomUUID } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { logActivity } from '../db/activityLog.js'
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

/**
 * Mirror image of findCandidates' BACKUP_FOLDER_RE exclusion — instead of
 * skipping everything under a zzz/To Delete folder, walks the whole tree
 * specifically to collect audio files sitting *inside* one. Used to tell
 * "this book's file genuinely disappeared" apart from "this book's file
 * was moved into the trash" (see removeTrashedBooks below), which a plain
 * missing-file check can't distinguish — a move into a trash folder is
 * usually also a rename, so this only needs to gather candidates here;
 * the actual matching happens by content hash, not by name.
 */
async function findTrashAudioFiles(dir: string, insideExcludedFolder = false): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return [] // unreadable dir (permissions, a broken symlink, etc.) — skip rather than fail the scan
  }

  const results: string[] = []
  if (insideExcludedFolder) {
    for (const e of entries) {
      if (e.isFile() && (isM4bFile(e.name) || e.name.toLowerCase().endsWith('.mp3'))) {
        results.push(path.join(dir, e.name))
      }
    }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const subDir = path.join(dir, e.name)
    results.push(...(await findTrashAudioFiles(subDir, insideExcludedFolder || BACKUP_FOLDER_RE.test(e.name))))
  }
  return results
}

/** Content hash -> file path, for every audio file currently sitting in a
 * zzz/To Delete-style folder anywhere under pathScope. Only worth the
 * extra directory walk when there's actually a missing book to check
 * against — see its one call site in scanSource. */
async function buildTrashHashIndex(pathScope: string): Promise<Map<string, string>> {
  const files = await findTrashAudioFiles(pathScope)
  const index = new Map<string, string>()
  for (const filePath of files) {
    try {
      index.set(await contentHash(filePath), filePath)
    } catch (err) {
      console.warn(`Skipping unreadable file while checking trash folders for removable books: ${filePath}`, err)
    }
  }
  return index
}

/** Deletes a book outright (chapters cascade via ON DELETE CASCADE) plus
 * its generated artwork files on disk — reserved for the specific cases of
 * a file having moved into a zzz/To Delete folder (removeTrashedBooks), a
 * just-created duplicate row being folded into an auto-replaced book's
 * identity (autoReplaceMissingBooks), or a user manually clearing a missing
 * book from the Needs Attention page (DELETE /api/books/:id). Progress/
 * bookmarks live in the separate cloud sync layer, unaffected either way. */
export async function deleteBookAndArtwork(book: BookRow): Promise<void> {
  getDb().prepare('DELETE FROM books WHERE id = ?').run(book.id)
  for (const artworkPath of [book.artwork_thumb_path, book.artwork_full_path]) {
    if (!artworkPath) continue
    try {
      await unlink(artworkPath)
    } catch {
      // Already gone or otherwise unreadable — not worth failing the scan over a stale thumbnail file.
    }
  }
}

interface NewlyCreatedBook {
  bookId: string
  candidate: Candidate
  hash: string
  title: string
  author: string | null
}

// Deliberately conservative — this acts with no human review, so a false
// positive would silently graft one book's identity onto a completely
// different one. Same word-overlap approach as relink.ts's manual-
// suggestion ranking, just held to a stricter bar and required to be an
// unambiguous single winner (see autoReplaceMissingBooks).
const AUTO_REPLACE_MIN_SCORE = 3

function normalizeWordsForMatch(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2)
}

// Title words only — deliberately ignores author. Candidates are already
// scoped to the same top-level (author) folder before this is called, so
// author words would just double-count a signal the folder scoping already
// guarantees, and can trivially clear AUTO_REPLACE_MIN_SCORE on their own
// for any multi-word author name (e.g. "Ursula K Le Guin" contributes 3
// matching words with zero title overlap) — a false-positive match between
// two otherwise-unrelated books by the same author.
function titleMatchScore(aTitle: string, bTitle: string): number {
  const aWords = new Set(normalizeWordsForMatch(aTitle))
  const bWords = new Set(normalizeWordsForMatch(bTitle))
  let score = 0
  for (const w of aWords) if (bWords.has(w)) score++
  return score
}

function topLevelFolderOf(pathScope: string, filePath: string): string | undefined {
  return path.relative(pathScope, filePath).split(path.sep)[0]
}

/**
 * A book that was re-encoded (not just renamed — a genuine content-hash
 * change, since a rename alone already auto-relinks by hash above) shows
 * up as two disconnected things after a plain scan: the old book stuck
 * missing forever, and the new file sitting as an unrelated brand-new
 * book. This finds the confident case and merges them — the new file's
 * data gets written under the OLD book's id (same mechanism as a manual
 * relink), and the redundant just-created duplicate row is removed —
 * so the book's identity carries forward onto its replacement instead of
 * needing a manual relink every time.
 *
 * Deliberately narrow: scoped to the same top-level (author) folder —
 * author itself is deliberately excluded from the match score, since local
 * candidates always derive author from that same folder name, so it would
 * just double-count what the folder scoping already guarantees — requires
 * a title word-overlap score at or above AUTO_REPLACE_MIN_SCORE (capped to
 * the missing title's own word count for short titles), and only acts when
 * that's an unambiguous single
 * winner — no tie for the missing book's best match, and no OTHER missing
 * book scoring as well or better against the same candidate. Anything
 * less confident is left for removeTrashedBooks / plain missing-marking,
 * and ultimately manual relink, rather than guessed at automatically.
 */
async function autoReplaceMissingBooks(
  source: SourceRow,
  missingBooks: BookRow[],
  newlyCreated: NewlyCreatedBook[],
  seriesSiblingCounts: Map<string, number>,
  result: ScanResult,
): Promise<Set<string>> {
  const replacedIds = new Set<string>()
  if (missingBooks.length === 0 || newlyCreated.length === 0) return replacedIds

  const db = getDb()
  const claimedCandidateIds = new Set<string>()

  for (const missing of missingBooks) {
    const authorFolder = topLevelFolderOf(source.path_scope, missing.file_path)
    if (!authorFolder) continue

    const sameFolderCandidates = newlyCreated.filter(
      (c) => !claimedCandidateIds.has(c.bookId) && topLevelFolderOf(source.path_scope, c.candidate.filePath) === authorFolder,
    )
    if (sameFolderCandidates.length === 0) continue

    // AUTO_REPLACE_MIN_SCORE is a ceiling, not a flat floor — cap it at the
    // missing title's own significant-word count so short titles (e.g. a
    // two-word title) can still clear the bar on a full match, rather than
    // being permanently unmatchable because they never reach 3 words.
    const requiredScore = Math.max(1, Math.min(AUTO_REPLACE_MIN_SCORE, normalizeWordsForMatch(missing.title).length))

    const scored = sameFolderCandidates
      .map((c) => ({ candidate: c, score: titleMatchScore(missing.title, c.title) }))
      .sort((a, b) => b.score - a.score)

    const best = scored[0]
    if (best.score < requiredScore) continue
    if (scored.length > 1 && scored[1].score === best.score) continue // ambiguous — two equally good matches, don't guess

    // A candidate can only replace one book — make sure no OTHER missing
    // book scores as well or better against this same new file.
    const rivalScore = missingBooks
      .filter((m) => m.id !== missing.id)
      .reduce((max, m) => Math.max(max, titleMatchScore(m.title, best.candidate.title)), -1)
    if (rivalScore >= best.score) continue

    const duplicate = db.prepare('SELECT * FROM books WHERE id = ?').get(best.candidate.bookId) as BookRow | undefined
    if (!duplicate) continue // already claimed/removed by an earlier iteration somehow — skip defensively

    await applyIngestedCandidate(source, best.candidate.candidate, missing.id, best.candidate.hash, seriesSiblingCounts)
    // The just-created duplicate's own "created" log entry is now
    // misleading (it's not a separate book after all) — remove it before
    // logging the merge itself.
    db.prepare("DELETE FROM activity_log WHERE book_id = ? AND action = 'created'").run(duplicate.id)
    await deleteBookAndArtwork(duplicate)

    // The duplicate's original "created" no longer represents a real,
    // still-existing book — this scan's counts should reflect that it
    // ended up being a replace, not a distinct new addition.
    result.created--
    result.autoReplaced++
    claimedCandidateIds.add(best.candidate.bookId)
    replacedIds.add(missing.id)
    logActivity(
      missing.id,
      best.candidate.title,
      best.candidate.author,
      'relinked',
      `Auto-replaced with a re-encoded/changed file (confident match, score ${best.score}) — was ${missing.file_path}`,
    )
  }

  return replacedIds
}

/**
 * Books whose file has moved into a zzz/To Delete folder are removed from
 * the library outright rather than left as a permanent "missing" ghost —
 * matched by content hash (not path/name, since a move into the trash is
 * usually also a rename). Checks both books just now going missing this
 * scan (`newlyMissing`) and books already sitting as missing from a past
 * scan (`alreadyMissing`), so this also retroactively cleans up anything
 * that was moved to trash before this check existed — a book with no
 * recorded content_hash (pre-dating that column) simply never matches,
 * the safe default.
 */
async function removeTrashedBooks(
  source: SourceRow,
  newlyMissing: BookRow[],
  alreadyMissing: BookRow[],
  result: ScanResult,
): Promise<void> {
  if (newlyMissing.length === 0 && alreadyMissing.length === 0) return
  const db = getDb()
  const trashHashes = await buildTrashHashIndex(source.path_scope)

  for (const book of newlyMissing) {
    if (book.content_hash && trashHashes.has(book.content_hash)) {
      const trashPath = trashHashes.get(book.content_hash)
      await deleteBookAndArtwork(book)
      result.removedAsTrash++
      logActivity(book.id, book.title, book.author, 'removed', `Same content found in a trash folder: ${trashPath}`)
    } else {
      db.prepare("UPDATE books SET status = 'missing', updated_at = datetime('now') WHERE id = ?").run(book.id)
      result.markedMissing++
      logActivity(book.id, book.title, book.author, 'missing', `File no longer found at ${book.file_path}`)
    }
  }

  for (const book of alreadyMissing) {
    if (book.content_hash && trashHashes.has(book.content_hash)) {
      const trashPath = trashHashes.get(book.content_hash)
      await deleteBookAndArtwork(book)
      result.removedAsTrash++
      logActivity(book.id, book.title, book.author, 'removed', `Same content found in a trash folder: ${trashPath}`)
    }
  }
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
  /** Books whose file was found to have moved into a zzz/To Delete-style
   * folder (matched by content hash, not path — a move is usually also a
   * rename) rather than genuinely gone missing. Removed outright instead
   * of left as a permanent "missing" ghost — see removeTrashedBooks. Local
   * scans only; remote sources have no local trash-folder concept. */
  removedAsTrash: number
  /** A missing book whose replacement (re-encoded, so a different content
   * hash — a rename alone would have hash-relinked already) was
   * confidently identified among this scan's newly-created books and
   * merged onto the old book's identity instead of sitting as two
   * separate rows (one missing, one new) — see autoReplaceMissingBooks.
   * Counted separately from `created`, even though the replacement file
   * technically passed through candidate ingestion once as a plain
   * create before being merged. */
  autoReplaced: number
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
    const result: ScanResult = {
      found: 0,
      created: 0,
      updated: 0,
      markedMissing: 0,
      skippedDuplicates: 0,
      failed: 1,
      removedAsTrash: 0,
    autoReplaced: 0,
    }
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
    removedAsTrash: 0,
    autoReplaced: 0,
  }
  const seenFilePaths = new Set<string>()
  const newlyCreated: NewlyCreatedBook[] = []

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

      const wasHashRelink = Boolean(existing && existing.file_path !== candidate.filePath)
      const previousPath = existing?.file_path

      const { bookId, created } = await applyIngestedCandidate(source, candidate, existing?.id, hash, seriesSiblingCounts)
      if (created) {
        result.created++
        const book = db.prepare('SELECT title, author FROM books WHERE id = ?').get(bookId) as
          | { title: string; author: string | null }
          | undefined
        if (book) {
          logActivity(bookId, book.title, book.author, 'created')
          newlyCreated.push({ bookId, candidate, hash, title: book.title, author: book.author })
        }
      } else {
        result.updated++
        if (wasHashRelink) {
          const book = db.prepare('SELECT title, author FROM books WHERE id = ?').get(bookId) as
            | { title: string; author: string | null }
            | undefined
          if (book) logActivity(bookId, book.title, book.author, 'relinked', `Same content found at a new path — moved from ${previousPath}`)
        }
      }
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
  // stays stable. The one exception is a file that moved into a zzz/To
  // Delete folder specifically — see removeTrashedBooks, which also
  // sweeps books already sitting as missing from a past scan.
  const previouslyActive = db
    .prepare<[string], BookRow>("SELECT * FROM books WHERE source_id = ? AND status = 'active'")
    .all(source.id)
  const newlyMissing = previouslyActive.filter((book) => !seenFilePaths.has(book.file_path))
  const alreadyMissing = db
    .prepare<[string], BookRow>("SELECT * FROM books WHERE source_id = ? AND status = 'missing'")
    .all(source.id)

  const autoReplacedIds = await autoReplaceMissingBooks(
    source,
    [...newlyMissing, ...alreadyMissing],
    newlyCreated,
    seriesSiblingCounts,
    result,
  )
  await removeTrashedBooks(
    source,
    newlyMissing.filter((b) => !autoReplacedIds.has(b.id)),
    alreadyMissing.filter((b) => !autoReplacedIds.has(b.id)),
    result,
  )

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
