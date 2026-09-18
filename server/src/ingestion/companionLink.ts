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
//
// Common connective words are excluded — real false match found in
// production: "the"/"and" alone were inflating overlap scores between
// completely unrelated books (Robin Hobb's "Assassin's Fate" vs "Fool's
// Fate", two different books in two different trilogies, tied at a
// passing score partly on "the" appearing in both folder paths).
const STOPWORDS = new Set(['the', 'and', 'for', 'of', 'in', 'on', 'at', 'is', 'to', 'with', 'from', 'book', 'novel'])

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
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

// Real bug found in production: for a *flat* series folder (siblings sit
// directly in it, no per-book subfolder — e.g. "Anthony, Piers/Bio of a
// Space Tyrant/Mercenary.m4b" next to "...Refugee.m4b"), the containing
// folder alone is identical for every book in that series — so this
// signal alone couldn't distinguish "Mercenary" from "Refugee" from
// "Politician" at all, and every sibling tied at the same score (510 of
// 730 real audiobook/ebook pairs in this library were blocked this way).
// Including the file's own basename fixes it: two files named the same
// thing carry a real, book-specific word match on top of whatever the
// shared series folder already contributed, so the correct sibling
// scores higher than the merely-same-folder ones instead of tying with
// them. Purely additive — never removes a signal a correct match already
// had — so this can only turn a tie into a clear winner, never invent a
// tie or a wrong winner that wasn't already possible before.
function relativePathWords(book: Pick<BookRow, 'format' | 'file_path'>, sourcePathScope: string): string[] {
  const folderWords = normalizeWords(path.relative(sourcePathScope, bookOwnFolder(book)))
  if (book.format === 'mp3_folder') return folderWords // file_path IS the folder — no separate filename to add
  const basenameWords = normalizeWords(path.basename(book.file_path, path.extname(book.file_path)))
  return [...folderWords, ...basenameWords]
}

const AUTO_LINK_MIN_SCORE = 3

// Real false-match found in production, twice over: a shared *series* or
// *character* name bleeding across an author's whole catalog is not a
// reliable per-book signal, even with the author's own name subtracted
// out. "Assassin's Fate" (Robin Hobb, The Fitz and the Fool) and "Fool's
// Fate" (Robin Hobb, The Tawny Man) are two entirely different books in
// two different trilogies, but the recurring character "the Fool" shows
// up in both the folder name and the title, on top of "hobb"+"robin"
// author overlap — enough to pass with zero *book-specific* overlap.
// Likewise "9th Judgement" (Patterson, Women's Murder Club) very nearly
// tied against the unrelated "Confessions of a Murder Suspect", purely
// because "murder" is the audiobook's own series-folder name, not
// anything about the specific book. A folder or filename can echo an
// author's series/character vocabulary in a way a book's own <title>
// field never coincidentally does — so the gate requires genuine overlap
// in the *title* fields specifically, not just anywhere in the combined
// signal.
//
// A single shared word still isn't enough on its own, though — real case
// just above (Hobb): "Assassin's Fate" and "Fool's Fate" share "fate" and
// nothing else, which is exactly the same shape as a false match, not a
// real one. Requiring either 2+ shared words, or the *entire* shorter
// title to be contained in the longer one, tells the two apart: a
// subtitle/edition suffix ("Inferno" vs "Inferno: A Novel" — "a novel" is
// generic-word-filtered down to just "inferno" either side, a full
// subset) still passes, and so does an exact single-word title match
// ("Mercenary" vs "Mercenary"), but two different books that merely
// share one incidental word out of several do not.
function hasTitleOverlap(aTitle: string, bTitle: string): boolean {
  const aWords = new Set(normalizeWords(aTitle))
  const bWords = new Set(normalizeWords(bTitle))
  if (aWords.size === 0 || bWords.size === 0) return false
  const overlap = overlapScore([...aWords], [...bWords])
  if (overlap >= 2) return true
  const [smaller, larger] = aWords.size <= bWords.size ? [aWords, bWords] : [bWords, aWords]
  return [...smaller].every((w) => larger.has(w))
}

/**
 * Two independent signals, since the user's ebooks and audiobooks live in
 * separate source folder trees rather than side-by-side (see
 * scan.ts/findCandidates' epub detection): title+author word overlap
 * (works even if folder conventions differ), and relative-path word
 * overlap — folder *and* filename, see relativePathWords — a much
 * stronger signal when both sources are organized the same Author/Title
 * way (see Claude.md's ebook-support discussion). The higher of the two
 * decides the match, but only once hasTitleOverlap has already confirmed
 * this isn't just two different books sharing an author's own recurring
 * vocabulary (see its comment) — a mismatched title across formats (a
 * subtitle, an "(Unabridged)" suffix) still passes that gate as long as
 * the core title word survives, so this isn't as strict as requiring an
 * exact title match.
 */
export function companionMatchScore(
  a: Pick<BookRow, 'format' | 'file_path' | 'title' | 'author'>,
  aSource: Pick<SourceRow, 'path_scope'>,
  b: Pick<BookRow, 'format' | 'file_path' | 'title' | 'author'>,
  bSource: Pick<SourceRow, 'path_scope'>,
): number {
  if (!hasTitleOverlap(a.title, b.title)) return 0

  const aWords = [...normalizeWords(a.title), ...normalizeWords(a.author ?? '')]
  const bWords = [...normalizeWords(b.title), ...normalizeWords(b.author ?? '')]
  const titleAuthorScore = overlapScore(aWords, bWords)
  const pathScore = overlapScore(relativePathWords(a, aSource.path_scope), relativePathWords(b, bSource.path_scope))
  return Math.max(titleAuthorScore, pathScore)
}

export interface CompanionLinkResult {
  linked: number
}

// The user's own mental model, stated directly: the local disk and the
// Synology NAS are "basically one source" (the home library), while
// Google Drive (and, by the same reasoning, Dropbox) is an external
// source that should never be auto-paired with a home-library book —
// even when a title/path match would otherwise score well. Real case
// that prompted this: "Cold Days: A Novel of the Dresden Files" (a local
// ebook) auto-linked to a Google Drive copy of "The Dresden Files 14.0 -
// Cold Days" over the user's own NAS copy of "Cold Days", purely because
// the Google Drive file's more verbose name happened to repeat "Dresden
// Files" from the ebook's own subtitle — a coincidence of naming, not a
// meaningful signal that the external copy was the right one. Explicit
// opt-in list (rather than "exclude cloud types") so a future third
// source type defaults to participating unless someone decides otherwise.
const HOME_LIBRARY_SOURCE_TYPES = new Set<SourceRow['type']>(['local', 'synology'])

function isHomeLibrarySource(source: Pick<SourceRow, 'type'>): boolean {
  return HOME_LIBRARY_SOURCE_TYPES.has(source.type)
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
  const sourcesById = new Map((db.prepare('SELECT * FROM sources').all() as SourceRow[]).map((s) => [s.id, s]))
  const isHomeLibraryBook = (b: BookRow): boolean => {
    const source = sourcesById.get(b.source_id)
    return !!source && isHomeLibrarySource(source)
  }

  // External sources (Google Drive, Dropbox) never participate in
  // auto-linking on either side — see HOME_LIBRARY_SOURCE_TYPES' comment.
  // An external audiobook simply stays unlinked; if the user wants it
  // paired with an ebook anyway, the manual link-companion endpoint still
  // works regardless of source.
  const audioBooks = (
    db.prepare("SELECT * FROM books WHERE format IN ('m4b', 'mp3_folder') AND companion_book_id IS NULL").all() as BookRow[]
  ).filter(isHomeLibraryBook)
  const epubBooks = (
    db.prepare("SELECT * FROM books WHERE format = 'epub' AND companion_book_id IS NULL").all() as BookRow[]
  ).filter(isHomeLibraryBook)
  if (audioBooks.length === 0 || epubBooks.length === 0) return { linked: 0 }

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
