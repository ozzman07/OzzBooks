import path from 'node:path'
import { getDb } from '../db/index.js'
import type { BookRow } from '../types.js'
import { deriveComicArcFromSegments } from './comic.js'

export interface ComicArcBackfillResult {
  attempted: number
  updated: number
}

/**
 * One-time catch-up for cbz books ingested before arc_name existed — pure
 * local path-string derivation against data already in the DB (the book's
 * own file_path plus its source's path_scope), no filesystem access
 * needed, so it runs against the whole library in well under a second.
 * Mirrors seriesNumberBackfill.ts's shape.
 *
 * Scoped to arc_name IS NULL only, so it's safe to re-run anytime — a book
 * whose folder genuinely has no arc (sits directly under its series
 * folder) keeps matching this query forever since its arc_name legitimately
 * stays null, same accepted trade-off seriesNumberBackfill already has for
 * a series-less book.
 */
export function backfillComicArcNames(): ComicArcBackfillResult {
  const db = getDb()
  const candidates = db
    .prepare(
      `SELECT books.*, sources.path_scope AS source_path_scope
       FROM books
       JOIN sources ON sources.id = books.source_id
       WHERE books.format = 'cbz' AND books.arc_name IS NULL`,
    )
    .all() as (BookRow & { source_path_scope: string })[]

  let updated = 0
  const update = db.prepare('UPDATE books SET arc_name = ? WHERE id = ?')
  for (const book of candidates) {
    const relativeSegments = path.relative(book.source_path_scope, book.file_path).split(path.sep)
    const arcName = deriveComicArcFromSegments(relativeSegments)
    if (arcName !== null) {
      update.run(arcName, book.id)
      updated++
    }
  }

  return { attempted: candidates.length, updated }
}
