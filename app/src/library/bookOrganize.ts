import type { Book } from '../types'
import type { LocalProgressEntry } from '../offline/db'
import type { StatusFilter } from './LibraryViewContext'

export function isAudioFormat(book: Book): boolean {
  return book.format === 'm4b' || book.format === 'mp3_folder'
}

export function isComicFormat(book: Book): boolean {
  return book.format === 'cbz'
}

// A companion pair (an audiobook and an ebook linked to each other — see
// companionLink.ts server-side) exists as two separate book rows, one per
// format. Shown as a single tile with a combo badge rather than two
// separate tiles for what a person thinks of as one book: drops the
// ebook-side row whenever its audio companion is also in this list, which
// then carries both badges instead. Comics have no companion concept (per
// Ozzbooks_Addendum_Comics: "no evidence this is a real case... don't
// build it speculatively"), so this is a no-op for them — every cbz row
// passes through unchanged.
export function dedupeCompanionPairs(books: Book[]): Book[] {
  const audioIds = new Set(books.filter(isAudioFormat).map((b) => b.id))
  return books.filter((b) => !(b.format === 'epub' && b.companionBookId && audioIds.has(b.companionBookId)))
}

// Reached-the-last-chapter is a proxy for "finished" for audio, same
// reasoning as before — precise duration comparison doesn't scale to a
// library this size. A comic has no chapters at all (pages are addressed
// by index, not a chapters table) — "finished" there means the saved
// position reached the last page, using the same position data already
// synced for the reader's own progress tracking.
export function isBookRead(book: Book, progress: LocalProgressEntry | undefined): boolean {
  if (!progress) return false
  if (isComicFormat(book)) {
    return progress.position.type === 'page' && book.pageCount !== undefined && progress.position.value >= book.pageCount - 1
  }
  return Boolean(book.lastChapterId) && progress.chapterId === book.lastChapterId
}

export function bookStatus(book: Book, progress: LocalProgressEntry | undefined): StatusFilter {
  if (!progress) return 'not-started'
  return isBookRead(book, progress) ? 'finished' : 'in-progress'
}

export function collate(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

// Many titles in this library are still raw filename fragments rather
// than clean human titles — ingestion doesn't clean these up yet (see
// Claude.md's planned Phase 2b title-cleaning work, not built). Sorting
// on the raw string clusters unrelated numbered-prefix files together
// ("01 - Ender's Game - Orson Scott Card - 1985", "01_light_of_other_days")
// under digits instead of landing near where a person would actually look
// for them, and titles that start with punctuation ('"Salem's Lot',
// "(Parenthetical) Book", "#1 Bestseller") sort ahead of the alphabet
// instead of under the letter a reader expects. This only computes a sort
// KEY — the displayed title is never changed, and a title without any of
// these artifacts passes through unchanged. Known limitation: doesn't
// strip trailing "- Author - Year" noise, since that pattern is too
// variable to target safely without the full title-cleaning pass.
export function titleSortKey(title: string): string {
  return title
    .replace(/^[^\p{L}\p{N}]+/u, '') // leading punctuation/symbols (quotes, parens, #, etc.) — not part of the actual title
    .replace(/^\d{1,3}\s*[._-]\s*/, '') // leading track-number-style prefix ("01 - ", "001.", "00_")
    .replace(/_/g, ' ') // raw filename fragments use underscores instead of spaces
    .replace(/^(the|a|an)\s+/i, '') // ignore a leading article, matching conventional library alphabetization
    .trim()
}

// Author tags in this library are a mix of "First Last" (the common case)
// and already-inverted "Last, First" (e.g. "Clarke, Arthur C.") — plus some
// multi-author/role-annotated strings ("Eric Flint, Andrew Dennis",
// "Arthur Conan Doyle, Stephen Fry - introductions"). The two single-author
// formats are reliably told apart by word count before the first comma:
// "Last, First" always has exactly one word there ("Clarke"), while
// multi-author strings have two or more ("Eric Flint"). Falls back to the
// last word of that segment either way, which also handles plain
// "First Last" (no comma at all).
//
// Known limitation: a tag with the narrator listed first, e.g.
// "Will Patton, Stephen King" (Patton narrates, King wrote it), sorts under
// "Patton" — there's no reliable way to tell narrator-first from
// author-first in a plain string tag. Display is never affected, only sort
// order.
export function authorSortKey(author: string): string {
  const [firstSegment] = author.split(',')
  const words = firstSegment.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return author
  const isAlreadyLastFirst = words.length === 1 && author.includes(',')
  return isAlreadyLastFirst ? words[0] : words[words.length - 1]
}

export function collateByAuthor(a: string, b: string): number {
  return collate(authorSortKey(a), authorSortKey(b)) || collate(a, b)
}

// Books outside a series sort by their own title, alongside series names,
// so everything still lands in one coherent list rather than being split
// into separate "grouped"/"ungrouped" runs.
export function compareBySeriesThenTitle(a: Book, b: Book): number {
  const seriesCompare = collate(titleSortKey(a.seriesName ?? a.title), titleSortKey(b.seriesName ?? b.title))
  if (seriesCompare !== 0) return seriesCompare
  return compareWithinSeries(a, b)
}

// Ordering *within* one already-matched series — series_number when either
// side has one (folder/tag/manual-derived — see seriesNumber.ts server-
// side and the comics addendum's folder-tier parsing), title otherwise.
// Missing numbers sort after numbered ones rather than colliding at 0, so
// a partially-numbered series (some issues tagged, some not) doesn't
// interleave a null-as-zero book ahead of #1.
export function compareWithinSeries(a: Book, b: Book): number {
  const aNum = a.seriesNumber ?? Number.MAX_SAFE_INTEGER
  const bNum = b.seriesNumber ?? Number.MAX_SAFE_INTEGER
  return aNum - bNum || collate(titleSortKey(a.title), titleSortKey(b.title))
}

export interface SeriesGroup {
  seriesName: string
  books: Book[]
}

// Only a folder-derived series with 2+ books reads as an actual series for
// browsing purposes — a lone book under a detected "series" folder is more
// likely an incidental intermediate folder than a real series, so it folds
// into the standalone bucket instead of cluttering the view with singleton
// groups.
//
// The 2+ threshold is checked against `catalogBooks` (defaulting to `books`
// itself), not `books` alone — `books` may already be a narrowed-down list
// (My Library's shelf-only subset, a search match), and a series being real
// is a property of the catalog, not of how much of it happens to be
// currently visible. Without this split, shelving just one issue of a
// 938-book series (or searching down to one match) would wrongly relabel
// it "Not part of a series" even though the series obviously exists.
export function groupBySeries(
  books: Book[],
  catalogBooks: Book[] = books,
): { series: SeriesGroup[]; standalone: Book[] } {
  const catalogCounts = new Map<string, number>()
  for (const book of catalogBooks) {
    if (!book.seriesName) continue
    catalogCounts.set(book.seriesName, (catalogCounts.get(book.seriesName) ?? 0) + 1)
  }

  const bySeriesName = new Map<string, Book[]>()
  const standalone: Book[] = []
  for (const book of books) {
    if (!book.seriesName || (catalogCounts.get(book.seriesName) ?? 0) < 2) {
      standalone.push(book)
      continue
    }
    const list = bySeriesName.get(book.seriesName) ?? []
    list.push(book)
    bySeriesName.set(book.seriesName, list)
  }

  const series: SeriesGroup[] = [...bySeriesName].map(([seriesName, group]) => ({
    seriesName,
    books: group.slice().sort(compareWithinSeries),
  }))

  series.sort((a, b) => collate(titleSortKey(a.seriesName), titleSortKey(b.seriesName)))
  standalone.sort((a, b) => collate(titleSortKey(a.title), titleSortKey(b.title)))
  return { series, standalone }
}

export interface ArcGroup {
  arcName: string
  books: Book[]
}

// Comics-only sub-grouping one level below series — within e.g. "Batman",
// clusters items that share an immediate parent folder (a story-arc
// collection like "Death of the Family", or a block of individually-filed
// weekly issues like "Batman Eternal") instead of Series Detail flattening
// every item directly under the series into one list of numbered files.
// See deriveComicArcFromSegments (comic.ts, server-side) for how arcName
// is derived from the folder path at ingestion. Same fold-singleton-into-
// standalone threshold as groupBySeries — a folder holding just one
// collected edition doesn't need its own heading, only a multi-item arc
// does. A book with no arcName (every non-comic format, plus a comic
// filed directly under its series folder) always lands in standalone, so
// this is a safe no-op when called on an audiobook/ebook series.
export function groupComicsByArc(books: Book[]): { arcs: ArcGroup[]; standalone: Book[] } {
  const byArcName = new Map<string, Book[]>()
  const standalone: Book[] = []
  for (const book of books) {
    if (!book.arcName) {
      standalone.push(book)
      continue
    }
    const list = byArcName.get(book.arcName) ?? []
    list.push(book)
    byArcName.set(book.arcName, list)
  }

  const arcs: ArcGroup[] = []
  for (const [arcName, group] of byArcName) {
    if (group.length < 2) {
      standalone.push(...group)
      continue
    }
    arcs.push({ arcName, books: group.slice().sort(compareWithinSeries) })
  }

  arcs.sort((a, b) => collate(titleSortKey(a.arcName), titleSortKey(b.arcName)))
  standalone.sort(compareWithinSeries)
  return { arcs, standalone }
}

export interface SeriesAuthorGroup {
  author: string
  books: Book[]
}

// Sub-grouping within one already-matched series for the (uncommon but
// real) case of a long-running multi-author series — James Bond being the
// motivating example: multiple continuation authors, each writing their
// own run, interleaved by seriesNumber/title into one confusing flat list
// otherwise. Deliberately NOT the same fold-singleton-into-standalone
// threshold groupBySeries/groupComicsByArc use: those guard against a
// *detected* grouping (a folder-derived name) that might not be a real
// series at all, so a lone match is suspicious. `author` is a direct,
// explicit tag, not a guess — a continuation author who wrote exactly one
// entry (not unusual for this pattern) is exactly as real a group as one
// who wrote ten, so every distinct author gets its own group here, no
// minimum size. Returns null when the whole series shares one author,
// since sub-grouping by the answer everyone already knows adds nothing.
export function groupSeriesByAuthor(books: Book[]): SeriesAuthorGroup[] | null {
  if (new Set(books.map((b) => b.author)).size < 2) return null

  const byAuthor = new Map<string, Book[]>()
  for (const book of books) {
    const list = byAuthor.get(book.author) ?? []
    list.push(book)
    byAuthor.set(book.author, list)
  }

  const groups: SeriesAuthorGroup[] = [...byAuthor].map(([author, group]) => ({
    author,
    books: group.slice().sort(compareWithinSeries),
  }))
  groups.sort((a, b) => collateByAuthor(a.author, b.author))
  return groups
}

export interface AuthorGroup {
  author: string
  seriesGroups: SeriesGroup[]
  standalone: Book[]
}

// Nests the same series-vs-standalone grouping used by the By Series view
// inside each author, instead of just sorting an author's books by series
// (which put same-series books adjacent but with no visual separation from
// whatever came before/after — hard to tell "these 3 tiles are one series"
// from a flat grid at a glance).
export function groupByAuthor(books: Book[]): AuthorGroup[] {
  const byAuthor = new Map<string, Book[]>()
  for (const book of books) {
    const list = byAuthor.get(book.author) ?? []
    list.push(book)
    byAuthor.set(book.author, list)
  }
  return [...byAuthor.entries()]
    .map(([author, group]) => {
      const { series, standalone } = groupBySeries(group)
      return { author, seriesGroups: series, standalone }
    })
    .sort((a, b) => collateByAuthor(a.author, b.author))
}
