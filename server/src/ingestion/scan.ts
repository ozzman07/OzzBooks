import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { getDb } from '../db/index.js'
import type { BookRow, SourceRow } from '../types.js'
import { ingestMp3Folder, type IngestedBook } from './mp3Folder.js'
import { ingestM4b, isDrmFile } from './m4b.js'
import { contentHash } from './contentHash.js'
import { extractArtwork } from './artwork.js'

interface Candidate {
  format: 'm4b' | 'mp3_folder'
  /** book-level path: the .m4b file, or the folder for mp3_folder books */
  filePath: string
  hashInput: string // file used to compute the dedup content hash
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

  for (const f of m4bFiles) {
    const filePath = path.join(dir, f.name)
    candidates.push({ format: 'm4b', filePath, hashInput: filePath })
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

async function ingestCandidate(candidate: Candidate): Promise<IngestedBook> {
  if (candidate.format === 'm4b') {
    return ingestM4b(candidate.filePath)
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
}

export async function scanSource(source: SourceRow): Promise<ScanResult> {
  const db = getDb()
  const candidates = await findCandidates(source.path_scope)

  const result: ScanResult = { found: candidates.length, created: 0, updated: 0, markedMissing: 0, skippedDuplicates: 0 }
  const seenFilePaths = new Set<string>()

  for (const candidate of candidates) {
    seenFilePaths.add(candidate.filePath)
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
    const bookId = existing?.id ?? randomUUID()
    const artwork = await extractArtwork(bookId, path.dirname(candidate.hashInput), ingested.artworkMetadata)

    const upsert = db.prepare(`
      INSERT INTO books (
        id, source_id, file_path, format, title, author, series_name, series_number,
        status, artwork_thumb_path, artwork_full_path, content_hash, updated_at
      ) VALUES (@id, @source_id, @file_path, @format, @title, @author, @series_name, @series_number,
        'active', @artwork_thumb_path, @artwork_full_path, @content_hash, datetime('now'))
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
    `)

    upsert.run({
      id: bookId,
      source_id: source.id,
      file_path: candidate.filePath,
      format: candidate.format,
      title: ingested.title,
      author: ingested.author,
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

  return result
}
