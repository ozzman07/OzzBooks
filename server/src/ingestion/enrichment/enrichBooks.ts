import { getDb } from '../../db/index.js'
import { saveArtworkBuffer } from '../artwork.js'
import type { BookRow } from '../../types.js'
import { searchWork, fetchCover } from './openLibrary.js'

// Server-side equivalent of app/src/pages/Library.tsx's titleSortKey(),
// extended further since this feeds a search query rather than a sort
// comparison — no code sharing exists between the two packages, so this
// stays a small duplicated function rather than an import. Strips a
// leading track-number-style prefix, normalizes underscores to spaces,
// drops a leading article, and (found necessary during a live spot-check
// against real library titles — "Congo - Michael Crichton" and "Beauty's
// Release (read by George Holmes)" both returned zero Open Library
// results otherwise) strips a trailing " - Author/Narrator" suffix and
// any parenthetical noise like "(read by X)"/"(Unabridged)".
function cleanTitleForSearch(title: string): string {
  return title
    .replace(/^\d{1,3}\s*[._-]\s*/, '')
    .replace(/_/g, ' ')
    .replace(/\s+-\s+.+$/, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface EnrichmentResult {
  attempted: number
  genreUpdated: number
  coverUpdated: number
  skipped: number
  failed: number
}

function markAttempted(bookId: string): void {
  getDb().prepare("UPDATE books SET metadata_enrichment_attempted_at = datetime('now') WHERE id = ?").run(bookId)
}

/**
 * Backfills genre + cover art from Open Library for books currently
 * missing either — never overwrites an existing value for either field.
 * Sequential, not parallel (Open Library's own rate limit is enforced
 * inside openLibrary.ts, but processing one book at a time here also
 * keeps this from looking like a burst of concurrent requests). Every
 * book gets metadata_enrichment_attempted_at stamped, hit or miss, so a
 * re-run doesn't re-query the same already-attempted books.
 */
export async function enrichBooks(): Promise<EnrichmentResult> {
  const db = getDb()
  const candidates = db
    .prepare(
      `SELECT * FROM books
       WHERE status = 'active'
         AND metadata_enrichment_attempted_at IS NULL
         AND (genre IS NULL OR (artwork_thumb_path IS NULL AND artwork_full_path IS NULL))
       ORDER BY created_at, rowid`,
    )
    .all() as BookRow[]

  const result: EnrichmentResult = { attempted: 0, genreUpdated: 0, coverUpdated: 0, skipped: 0, failed: 0 }

  for (const book of candidates) {
    result.attempted++
    try {
      const match = await searchWork(cleanTitleForSearch(book.title), book.author)
      if (!match) {
        result.skipped++
        markAttempted(book.id)
        continue
      }

      let genre = book.genre
      let artworkThumbPath = book.artwork_thumb_path
      let artworkFullPath = book.artwork_full_path

      if (!genre && match.genre) {
        genre = match.genre
        result.genreUpdated++
      }

      if (!artworkThumbPath && !artworkFullPath && match.coverId) {
        const coverBuffer = await fetchCover(match.coverId)
        if (coverBuffer) {
          const saved = await saveArtworkBuffer(book.id, coverBuffer)
          if (saved) {
            artworkThumbPath = saved.thumbPath
            artworkFullPath = saved.fullPath
            result.coverUpdated++
          }
        }
      }

      db.prepare(
        `UPDATE books SET genre = ?, artwork_thumb_path = ?, artwork_full_path = ?,
           metadata_enrichment_attempted_at = datetime('now')
         WHERE id = ?`,
      ).run(genre, artworkThumbPath, artworkFullPath, book.id)
    } catch (err) {
      console.warn(`Metadata enrichment failed for book ${book.id} (${book.title}):`, err)
      result.failed++
      markAttempted(book.id)
    }
  }

  return result
}
