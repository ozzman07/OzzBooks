import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../db/index.js'
import type { BookRow, SourceRow } from '../types.js'
import { ingestMp3Folder, type IngestedBook } from './mp3Folder.js'
import { ingestM4b, isDrmFile } from './m4b.js'
import { groupM4bParts } from './partGrouping.js'
import { contentHash } from './contentHash.js'
import { extractArtwork } from './artwork.js'

interface Candidate {
  format: 'm4b' | 'mp3_folder'
  /** book-level path: the first (or only) .m4b file, or the folder for mp3_folder books */
  filePath: string
  hashInput: string // file used to compute the dedup content hash
  /** For m4b: every file that's part of this book, in play order — length 1 in the common single-file case. */
  parts?: string[]
}

async function findCandidates(dir: string): Promise<Candidate[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile())
  const dirs = entries.filter((e) => e.isDirectory())

  const drm = files.filter((f) => isDrmFile(f.name))
  for (const f of drm) {
    console.warn(`Skipping DRM-encumbered file (out of scope): ${path.join(dir, f.name)}`)
  }

  const m4bFiles = files.filter((f) => f.name.toLowerCase().endsWith('.m4b'))
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

  // Recurse into subdirectories to support Author/Series/Book nesting —
  // but a directory already classified as a book's own folder is a leaf.
  if (m4bFiles.length === 0 && mp3Files.length === 0) {
    for (const d of dirs) {
      candidates.push(...(await findCandidates(path.join(dir, d.name))))
    }
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
function deriveAuthorFromFolder(pathScope: string, filePath: string): string | null {
  const relative = path.relative(pathScope, filePath)
  const [authorFolder, ...rest] = relative.split(path.sep)
  if (rest.length === 0) return null // file/folder sits directly at the source root, no author level
  if (!authorFolder || GARBLED_FOLDER_NAME_RE.test(authorFolder)) return null
  return authorFolder
}

async function ingestCandidate(candidate: Candidate): Promise<IngestedBook> {
  if (candidate.format === 'm4b') {
    return ingestM4b(candidate.parts ?? [candidate.filePath])
  }
  const entries = await readdir(candidate.filePath, { withFileTypes: true })
  const mp3Filenames = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.mp3')).map((e) => e.name)
  return ingestMp3Folder(candidate.filePath, mp3Filenames)
}

export interface ScanResult {
  found: number
  created: number
  updated: number
  markedMissing: number
  skippedDuplicates: number
  failed: number
}

export async function scanSource(source: SourceRow): Promise<ScanResult> {
  const db = getDb()
  const candidates = await findCandidates(source.path_scope)

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

      const existing = db
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
      }

      const ingested = await ingestCandidate(candidate)
      const author = deriveAuthorFromFolder(source.path_scope, candidate.filePath) ?? ingested.author
      const bookId = existing?.id ?? randomUUID()
      const artwork = await extractArtwork(bookId, path.dirname(candidate.hashInput), ingested.artworkMetadata)

      const upsert = db.prepare(`
        INSERT INTO books (
          id, source_id, file_path, format, title, author, series_name, series_number,
          status, artwork_thumb_path, artwork_full_path, content_hash, created_at, updated_at
        ) VALUES (@id, @source_id, @file_path, @format, @title, @author, @series_name, @series_number,
          'active', @artwork_thumb_path, @artwork_full_path, @content_hash, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          author = excluded.author,
          series_name = excluded.series_name,
          series_number = excluded.series_number,
          status = 'active',
          artwork_thumb_path = excluded.artwork_thumb_path,
          artwork_full_path = excluded.artwork_full_path,
          content_hash = excluded.content_hash,
          updated_at = datetime('now')
          -- created_at deliberately not touched on conflict — set once at
          -- first insert, preserved across every rescan after that
      `)

      upsert.run({
        id: bookId,
        source_id: source.id,
        file_path: candidate.filePath,
        format: candidate.format,
        title: ingested.title,
        author,
        series_name: ingested.seriesName,
        series_number: ingested.seriesNumber,
        artwork_thumb_path: artwork?.thumbPath ?? null,
        artwork_full_path: artwork?.fullPath ?? null,
        content_hash: hash,
      })

      db.prepare('DELETE FROM chapters WHERE book_id = ?').run(bookId)
      const insertChapter = db.prepare(`
        INSERT INTO chapters (id, book_id, idx, title, start_time, duration, file_path)
        VALUES (@id, @book_id, @idx, @title, @start_time, @duration, @file_path)
      `)
      ingested.chapters.forEach((chapter, idx) => {
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

      if (existing) result.updated++
      else result.created++
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
