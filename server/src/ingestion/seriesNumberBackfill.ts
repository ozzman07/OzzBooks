import path from 'node:path'
import { getDb } from '../db/index.js'
import type { BookRow } from '../types.js'
import { deriveSeriesNumberFromName } from './seriesNumber.js'

export interface SeriesNumberBackfillResult {
  attempted: number
  updated: number
}

/**
 * One-time catch-up for books ingested before series-number extraction
 * existed — unlike the genre/cover Open Library backfill, this is pure
 * local string matching against data already in the DB (no external API,
 * no rate limit), so it runs synchronously against the whole library in
 * well under a second rather than needing async job-tracking/polling.
 *
 * Scoped to series_number IS NULL only — never touches a book that
 * already has a number, whether from a tag, a prior run of this same
 * backfill, or a manual edit, so it's safe to re-run anytime.
 */
export function backfillSeriesNumbers(): SeriesNumberBackfillResult {
  const db = getDb()
  const candidates = db
    .prepare("SELECT * FROM books WHERE series_name IS NOT NULL AND series_number IS NULL")
    .all() as BookRow[]

  let updated = 0
  const update = db.prepare("UPDATE books SET series_number = ?, series_number_source = 'folder' WHERE id = ?")
  for (const book of candidates) {
    const guess =
      deriveSeriesNumberFromName(book.series_name!, path.basename(path.dirname(book.file_path))) ??
      deriveSeriesNumberFromName(book.series_name!, path.basename(book.file_path, path.extname(book.file_path)))
    if (guess !== null) {
      update.run(guess, book.id)
      updated++
    }
  }

  return { attempted: candidates.length, updated }
}
