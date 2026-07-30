import path from 'node:path'
import { getDb } from '../db/index.js'
import { logActivity } from '../db/activityLog.js'
import type { BookRow, SourceRow } from '../types.js'

// Same word-overlap approach as scan.ts's auto-replace and relink.ts's
// manual-suggestion ranking, but — unlike auto-replace's title-only score
// — author IS included here: auto-replace's candidates are already scoped
// to the same folder (so author overlap there is redundant with the
// folder scope itself, see scan.ts's titleMatchScore docstring), but a
// companion audiobook and ebook live in entirely separate source folder
// trees, so author is a genuinely independent signal here, not a
// duplicate of something folder-scoping already guarantees.
function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2)
}

function overlapScore(a: string[], b: string[]): number {
  const bSet = new Set(b)
  let score = 0
  for (const w of new Set(a)) if (bSet.has(w)) score++
  return score
}

function bookOwnFolder(book: Pick<BookRow, 'format' | 'file_path'>): string {
  return book.format === 'mp3_folder' ? book.file_path : path.dirname(book.file_path)
}

function relativeFolderWords(book: Pick<BookRow, 'format' | 'file_path'>, sourcePathScope: string): string[] {
  return normalizeWords(path.relative(sourcePathScope, bookOwnFolder(book)))
}

const AUTO_LINK_MIN_SCORE = 3

/**
 * Two independent signals, since the user's ebooks and audiobooks live in
 * separate source folder trees rather than side-by-side (see
 * scan.ts/findCandidates' epub detection): title+author word overlap
 * (works even if folder conventions differ), and relative-folder-path
 * word overlap (a much stronger signal when both sources are organized
 * the same Author/Title way — see Claude.md's ebook-support discussion).
 * The higher of the two decides the match; either one being strong
 * enough is sufficient, since a mismatched title across formats — a
 * subtitle, an "(Unabridged)" suffix — shouldn't block an otherwise
 * exact folder-path match, and vice versa.
 */
export function companionMatchScore(
  a: Pick<BookRow, 'format' | 'file_path' | 'title' | 'author'>,
  aSource: Pick<SourceRow, 'path_scope'>,
  b: Pick<BookRow, 'format' | 'file_path' | 'title' | 'author'>,
  bSource: Pick<SourceRow, 'path_scope'>,
): number {
  const aWords = [...normalizeWords(a.title), ...normalizeWords(a.author ?? '')]
  const bWords = [...normalizeWords(b.title), ...normalizeWords(b.author ?? '')]
  const titleAuthorScore = overlapScore(aWords, bWords)
  const pathScore = overlapScore(relativeFolderWords(a, aSource.path_scope), relativeFolderWords(b, bSource.path_scope))
  return Math.max(titleAuthorScore, pathScore)
}

export interface CompanionLinkResult {
  linked: number
}

/**
 * Pairs up not-yet-linked audiobook and ebook rows by confident match,
 * same conservative shape as scan.ts's autoReplaceMissingBooks: requires
 * an unambiguous single winner (no tie for the audiobook's best match, no
 * rival audiobook scoring as well or better against the same ebook)
 * before auto-linking — anything less confident is left for the manual
 * link endpoint (POST /api/books/:id/link-companion) instead of guessed
 * at. Called after every scan (see scanSource) so linking updates
 * immediately as either the audiobook or ebook source is (re)scanned,
 * not just once a day.
 */
export function runCompanionLinking(): CompanionLinkResult {
  const db = getDb()
  const audioBooks = db
    .prepare("SELECT * FROM books WHERE format IN ('m4b', 'mp3_folder') AND companion_book_id IS NULL")
    .all() as BookRow[]
  const epubBooks = db.prepare("SELECT * FROM books WHERE format = 'epub' AND companion_book_id IS NULL").all() as BookRow[]
  if (audioBooks.length === 0 || epubBooks.length === 0) return { linked: 0 }

  const sourcesById = new Map((db.prepare('SELECT * FROM sources').all() as SourceRow[]).map((s) => [s.id, s]))
  const claimedEpubIds = new Set<string>()
  let linked = 0

  for (const audio of audioBooks) {
    const audioSource = sourcesById.get(audio.source_id)
    if (!audioSource) continue

    const scored = epubBooks
      .filter((e) => !claimedEpubIds.has(e.id))
      .map((epub) => {
        const epubSource = sourcesById.get(epub.source_id)
        return epubSource ? { epub, score: companionMatchScore(audio, audioSource, epub, epubSource) } : null
      })
      .filter((s): s is { epub: BookRow; score: number } => s !== null)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) continue
    const best = scored[0]
    if (best.score < AUTO_LINK_MIN_SCORE) continue
    if (scored.length > 1 && scored[1].score === best.score) continue // ambiguous — two equally good matches

    const bestEpubSource = sourcesById.get(best.epub.source_id)
    if (!bestEpubSource) continue
    const rivalScore = audioBooks
      .filter((a) => a.id !== audio.id)
      .reduce((max, a) => {
        const aSource = sourcesById.get(a.source_id)
        return aSource ? Math.max(max, companionMatchScore(a, aSource, best.epub, bestEpubSource)) : max
      }, -1)
    if (rivalScore >= best.score) continue

    linkCompanions(audio.id, best.epub.id, `Auto-linked as a confident match (score ${best.score})`)
    claimedEpubIds.add(best.epub.id)
    linked++
  }

  return { linked }
}

/** Sets companion_book_id on both sides — a symmetric relationship,
 * always kept consistent on both rows rather than just one, so either
 * book's own detail page can look up its companion directly. */
export function linkCompanions(bookAId: string, bookBId: string, detail: string): void {
  const db = getDb()
  const bookA = db.prepare('SELECT * FROM books WHERE id = ?').get(bookAId) as BookRow | undefined
  const bookB = db.prepare('SELECT * FROM books WHERE id = ?').get(bookBId) as BookRow | undefined
  if (!bookA || !bookB) throw new Error('Both books must exist to link them as companions')

  db.prepare("UPDATE books SET companion_book_id = ?, updated_at = datetime('now') WHERE id = ?").run(bookBId, bookAId)
  db.prepare("UPDATE books SET companion_book_id = ?, updated_at = datetime('now') WHERE id = ?").run(bookAId, bookBId)
  logActivity(bookAId, bookA.title, bookA.author, 'metadata_updated', detail)
  logActivity(bookBId, bookB.title, bookB.author, 'metadata_updated', detail)
}

/** Clears companion_book_id on both sides — used when an auto-link (or an
 * earlier manual one) turns out to be wrong. */
export function unlinkCompanions(bookId: string): void {
  const db = getDb()
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as BookRow | undefined
  if (!book?.companion_book_id) return
  const companion = db.prepare('SELECT * FROM books WHERE id = ?').get(book.companion_book_id) as BookRow | undefined

  db.prepare("UPDATE books SET companion_book_id = NULL, updated_at = datetime('now') WHERE id = ?").run(bookId)
  db.prepare("UPDATE books SET companion_book_id = NULL, updated_at = datetime('now') WHERE id = ?").run(
    book.companion_book_id,
  )
  logActivity(book.id, book.title, book.author, 'metadata_updated', 'Companion link removed')
  if (companion) logActivity(companion.id, companion.title, companion.author, 'metadata_updated', 'Companion link removed')
}
