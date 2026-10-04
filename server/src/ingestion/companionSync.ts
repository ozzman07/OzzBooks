import { getDb } from '../db/index.js'
import type { BookRow } from '../types.js'

/**
 * Fields shared between an audiobook/ebook companion pair — the same work
 * regardless of format, so these should read the same on both sides.
 * Deliberately excludes narrator (audio-only), writer/penciller/publisher/
 * page_count/arc_name (comics-only, and comics never have a companion —
 * see companionLink.ts), and file/format-specific columns.
 */
export interface SharedMetadataPatch {
  title?: string
  title_source?: 'manual' | null
  author?: string | null
  author_source?: 'manual' | null
  series_name?: string | null
  series_name_source?: 'manual' | null
  series_number?: number | null
  series_number_source?: 'tag' | 'folder' | 'manual' | null
  genre?: string | null
  genre_source?: 'manual' | null
  synopsis?: string | null
  artwork_thumb_path?: string | null
  artwork_full_path?: string | null
}

function getCompanionId(bookId: string): string | null {
  const row = getDb().prepare('SELECT companion_book_id FROM books WHERE id = ?').get(bookId) as
    | { companion_book_id: string | null }
    | undefined
  return row?.companion_book_id ?? null
}

function runPatch(companionId: string, patch: SharedMetadataPatch): void {
  const keys = Object.keys(patch) as (keyof SharedMetadataPatch)[]
  if (keys.length === 0) return
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ')
  getDb()
    .prepare(`UPDATE books SET ${setClause} WHERE id = @id`)
    .run({ ...patch, id: companionId })
}

/**
 * Real bug found in production: "Look up metadata online" wrote a fresh
 * cover (and could just as easily have written title/author/genre/series)
 * to one companion row only — the other, representing the exact same
 * work, kept showing its old cover/placeholder, since the two rows have
 * always been stored as fully independent books. Same class of drift was
 * possible via a manual Book Detail edit. Call this right after any
 * deliberate, human-reviewed write (a PATCH or a metadata-lookup apply)
 * to mirror it onto companion_book_id too — unconditionally, since a
 * human decision about the work applies to the whole work, not just the
 * format they happened to be looking at.
 */
export function propagateToCompanion(bookId: string, patch: SharedMetadataPatch): void {
  const companionId = getCompanionId(bookId)
  if (!companionId) return
  runPatch(companionId, patch)
}

/**
 * Same idea, for enrichBooks.ts's automatic nightly/Settings backfill
 * instead of a human-reviewed action — gated per-field on the companion's
 * own value still being empty, same "only fill, never overwrite" rule
 * enrichBooks.ts already applies to the row it's actually processing.
 * Without this, two companion rows enrich independently (each runs its
 * own Open Library search) and can silently settle on different genres,
 * synopses, or covers for what is really one book.
 */
export function propagateToCompanionIfMissing(bookId: string, patch: SharedMetadataPatch): void {
  const companionId = getCompanionId(bookId)
  if (!companionId) return
  const companion = getDb().prepare('SELECT * FROM books WHERE id = ?').get(companionId) as BookRow | undefined
  if (!companion) return

  const effective: SharedMetadataPatch = {}
  for (const key of Object.keys(patch) as (keyof SharedMetadataPatch)[]) {
    if (companion[key] === null || companion[key] === undefined) {
      ;(effective[key] as unknown) = patch[key]
    }
  }
  runPatch(companionId, effective)
}
