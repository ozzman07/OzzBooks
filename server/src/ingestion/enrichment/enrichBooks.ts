import { getDb } from '../../db/index.js'
import { saveArtworkBuffer } from '../artwork.js'
import type { BookRow } from '../../types.js'
import { searchWork, fetchCover, OpenLibraryUnavailableError } from './openLibrary.js'
import { MAX_PLAUSIBLE_SERIES_NUMBER } from '../seriesNumber.js'

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
//
// A number sitting right before that same "-"/":" separator flips which
// side is noise: "Cinder Spires 1 - The Aeronaut's Windlass" and "Dresden
// Files 1 - Storm Front" are this library's dominant series-title
// convention (embedded in the tag itself, not just the filename) — the
// real, searchable title is what comes AFTER the separator, the series
// name + number before it is the noise. Confirmed directly against Open
// Library: the old suffix-stripped query "Cinder Spires 1" returned zero
// results; "The Aeronaut's Windlass" found it immediately. Gated by the
// same plausibility ceiling deriveSeriesNumberFromName uses so a real
// in-title number/year isn't misread as a series-number prefix (e.g. the
// "Odyssey Series/1997 - 3001 The Final Odyssey" case documented there —
// 1997 exceeds the ceiling, so this falls back to the old suffix-strip
// behavior instead, same as before this case was handled at all).
function cleanTitleForSearch(title: string): string {
  let cleaned = title.replace(/^\d{1,3}\s*[._-]\s*/, '').replace(/_/g, ' ').trim()

  const seriesPrefixMatch = cleaned.match(/^(.+?)\s+(\d{1,3}(?:\.\d+)?)\s*[-:]\s*(.+)$/)
  if (seriesPrefixMatch && Number(seriesPrefixMatch[2]) <= MAX_PLAUSIBLE_SERIES_NUMBER) {
    cleaned = seriesPrefixMatch[3]
  } else {
    cleaned = cleaned.replace(/\s+-\s+.+$/, '')
  }

  return cleaned
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface EnrichmentResult {
  attempted: number
  genreUpdated: number
  synopsisUpdated: number
  coverUpdated: number
  skipped: number
  failed: number
  /** True if the run stopped early because Open Library itself appears to
   * be unavailable (timeout/network/non-2xx), rather than running through
   * every remaining candidate. Whatever wasn't reached stays un-stamped,
   * so the next run — nightly or a manual Settings retry — picks up
   * exactly where this one left off instead of waiting for a full second
   * backlog to build up. */
  abortedDueToUnavailability: boolean
}

function markAttempted(bookId: string): void {
  getDb().prepare("UPDATE books SET metadata_enrichment_attempted_at = datetime('now') WHERE id = ?").run(bookId)
}

/**
 * Backfills genre + cover art from Open Library for books currently
 * missing either — never overwrites an existing value for either field.
 * Sequential, not parallel (Open Library's own rate limit is enforced
 * inside openLibrary.ts, but processing one book at a time here also
 * keeps this from looking like a burst of concurrent requests). Every book
 * successfully processed — matched, or confidently skipped as no-match —
 * gets metadata_enrichment_attempted_at stamped, so a re-run doesn't
 * re-query it. The one exception is stopping early on Open Library itself
 * being unavailable (see OpenLibraryUnavailableError) — that book and
 * everything after it is left un-stamped on purpose, to be retried next
 * run rather than treated as a settled no-match.
 */
export async function enrichBooks(): Promise<EnrichmentResult> {
  const db = getDb()
  const candidates = db
    .prepare(
      `SELECT * FROM books
       WHERE status = 'active'
         AND metadata_enrichment_attempted_at IS NULL
         AND (genre IS NULL OR synopsis IS NULL OR (artwork_thumb_path IS NULL AND artwork_full_path IS NULL))
       ORDER BY created_at, rowid`,
    )
    .all() as BookRow[]

  const result: EnrichmentResult = {
    attempted: 0,
    genreUpdated: 0,
    synopsisUpdated: 0,
    coverUpdated: 0,
    skipped: 0,
    failed: 0,
    abortedDueToUnavailability: false,
  }

  for (const book of candidates) {
    try {
      const match = await searchWork(cleanTitleForSearch(book.title), book.author)
      if (!match) {
        result.attempted++
        result.skipped++
        markAttempted(book.id)
        continue
      }

      let genre = book.genre
      let synopsis = book.synopsis
      let artworkThumbPath = book.artwork_thumb_path
      let artworkFullPath = book.artwork_full_path

      if (!genre && match.genre) {
        genre = match.genre
        result.genreUpdated++
      }

      if (!synopsis && match.synopsis) {
        synopsis = match.synopsis
        result.synopsisUpdated++
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

      result.attempted++
      db.prepare(
        `UPDATE books SET genre = ?, synopsis = ?, artwork_thumb_path = ?, artwork_full_path = ?,
           metadata_enrichment_attempted_at = datetime('now')
         WHERE id = ?`,
      ).run(genre, synopsis, artworkThumbPath, artworkFullPath, book.id)
    } catch (err) {
      if (err instanceof OpenLibraryUnavailableError) {
        // Deliberately leaves this book (and everything after it in
        // `candidates`) un-stamped — the next run, nightly or a manual
        // Settings retry, picks up right where this one stopped instead
        // of waiting for a full new backlog.
        console.warn(
          `Open Library appears unavailable, stopping metadata enrichment early (${result.attempted} book(s) processed this run):`,
          err,
        )
        result.abortedDueToUnavailability = true
        break
      }
      result.attempted++
      result.failed++
      console.warn(`Metadata enrichment failed for book ${book.id} (${book.title}):`, err)
      markAttempted(book.id)
    }
  }

  return result
}
