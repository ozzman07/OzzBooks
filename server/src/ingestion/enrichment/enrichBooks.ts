import { getDb } from '../../db/index.js'
import { saveArtworkBuffer } from '../artwork.js'
import type { BookRow } from '../../types.js'
import { searchWork, fetchCover } from './openLibrary.js'

// Server-side equivalent of app/src/pages/Library.tsx's titleSortKey() —
// no code sharing exists between the two packages, so this is a small
// duplicated function rather than an import. Same patterns: strip a
// leading track-number-style prefix, normalize underscores to spaces,
// drop a leading article — turns "01 - Ender's Game - Orson Scott Card -
// 1985" into something resembling a real title before it's used as a
// search query, without needing the full AI-based title extraction still
// on the roadmap.
function cleanTitleForSearch(title: string): string {
  return title
    .replace(/^\d{1,3}\s*[._-]\s*/, '')
    .replace(/_/g, ' ')
    .replace(/^(the|a|an)\s+/i, '')
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
