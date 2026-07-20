import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchBooks } from '../api/client'
import { adaptBookListItem } from '../api/adapter'
import { reconcileAllProgress, removeFromContinueListening } from '../offline/reconcile'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { formatDuration } from '../lib/format'
import type { Book } from '../types'
import type { LocalProgressEntry } from '../offline/db'
import { useLibraryView, type SortOption, type StatusFilter } from '../library/LibraryViewContext'

const SORT_LABELS: Record<SortOption, string> = {
  title: 'Title (A–Z)',
  author: 'Author (A–Z)',
  series: 'Series',
  recent: 'Recently added',
}

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  'not-started': 'Not started',
  'in-progress': 'In progress',
  finished: 'Finished',
}

// Reached-the-last-chapter is a proxy for "finished," not literally
// "played to the last second" — getting that precise would mean fetching
// every book's full chapter list just to compare position against that
// chapter's own duration, which doesn't scale to a library this size.
// Close enough to be useful as a coarse filter.
function bookStatus(book: Book, progress: LocalProgressEntry | undefined): StatusFilter {
  if (!progress) return 'not-started'
  if (book.lastChapterId && progress.chapterId === book.lastChapterId) return 'finished'
  return 'in-progress'
}

function collate(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

// Many titles in this library are still raw filename fragments rather
// than clean human titles — ingestion doesn't clean these up yet (see
// Claude.md's planned Phase 2b title-cleaning work, not built). Sorting
// on the raw string clusters unrelated numbered-prefix files together
// ("01 - Ender's Game - Orson Scott Card - 1985", "01_light_of_other_days")
// under digits instead of landing near where a person would actually look
// for them. This only computes a sort KEY — the displayed title is never
// changed, and a title without any of these artifacts passes through
// unchanged. Known limitation: doesn't strip trailing "- Author - Year"
// noise, since that pattern is too variable to target safely without the
// full title-cleaning pass.
function titleSortKey(title: string): string {
  return title
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
function authorSortKey(author: string): string {
  const [firstSegment] = author.split(',')
  const words = firstSegment.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return author
  const isAlreadyLastFirst = words.length === 1 && author.includes(',')
  return isAlreadyLastFirst ? words[0] : words[words.length - 1]
}

function collateByAuthor(a: string, b: string): number {
  return collate(authorSortKey(a), authorSortKey(b)) || collate(a, b)
}

// Books outside a series sort by their own title, alongside series names,
// so everything still lands in one coherent list rather than being split
// into separate "grouped"/"ungrouped" runs. No series *number* yet (folder
// names alone aren't a reliable source for it — see scan.ts), so books
// within the same series currently land in title order, not reading order;
// the planned LLM-assisted extraction will backfill series_number and this
// will automatically start using it once populated.
function compareBySeriesThenTitle(a: Book, b: Book): number {
  const seriesCompare = collate(
    titleSortKey(a.seriesName ?? a.title),
    titleSortKey(b.seriesName ?? b.title),
  )
  if (seriesCompare !== 0) return seriesCompare
  // No-op today (seriesNumber is always null until the LLM pass populates
  // it), kept so ordering within a series automatically switches from
  // title order to reading order the moment that data exists.
  return (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0) || collate(titleSortKey(a.title), titleSortKey(b.title))
}

interface SeriesGroup {
  seriesName: string
  books: Book[]
}

// Only a folder-derived series with 2+ books reads as an actual series for
// browsing purposes — a lone book under a detected "series" folder is more
// likely an incidental intermediate folder than a real series, so it folds
// into the standalone bucket instead of cluttering the view with singleton
// groups.
function groupBySeries(books: Book[]): { series: SeriesGroup[]; standalone: Book[] } {
  const bySeriesName = new Map<string, Book[]>()
  const standalone: Book[] = []
  for (const book of books) {
    if (!book.seriesName) {
      standalone.push(book)
      continue
    }
    const list = bySeriesName.get(book.seriesName) ?? []
    list.push(book)
    bySeriesName.set(book.seriesName, list)
  }

  const series: SeriesGroup[] = []
  for (const [seriesName, group] of bySeriesName) {
    if (group.length < 2) {
      standalone.push(...group)
      continue
    }
    series.push({ seriesName, books: group.slice().sort((a, b) => collate(titleSortKey(a.title), titleSortKey(b.title))) })
  }

  series.sort((a, b) => collate(titleSortKey(a.seriesName), titleSortKey(b.seriesName)))
  standalone.sort((a, b) => collate(titleSortKey(a.title), titleSortKey(b.title)))
  return { series, standalone }
}

interface AuthorGroup {
  author: string
  seriesGroups: SeriesGroup[]
  standalone: Book[]
}

// Nests the same series-vs-standalone grouping used by the By Series view
// inside each author, instead of just sorting an author's books by series
// (which put same-series books adjacent but with no visual separation from
// whatever came before/after — hard to tell "these 3 tiles are one series"
// from a flat grid at a glance).
function groupByAuthor(books: Book[]): AuthorGroup[] {
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

function BookTile({ book }: { book: Book }) {
  return (
    <Link to={`/book/${book.id}`} className="block">
      <div className="relative">
        <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
        {book.status === 'missing' && (
          <span className="absolute right-1 top-1 rounded bg-red-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
            Needs attention
          </span>
        )}
      </div>
      <p className="mt-1 truncate text-sm text-slate-100">{book.title}</p>
      <p className="truncate text-xs text-slate-400">{book.author}</p>
      <p className="text-xs text-slate-500">{formatDuration(book.totalDuration)}</p>
    </Link>
  )
}

function sortBooks(books: Book[], sortBy: SortOption): Book[] {
  return books.slice().sort((a, b) => {
    switch (sortBy) {
      case 'author':
        return collateByAuthor(a.author, b.author) || collate(titleSortKey(a.title), titleSortKey(b.title))
      case 'series':
        return compareBySeriesThenTitle(a, b)
      case 'recent':
        return b.createdAt.localeCompare(a.createdAt)
      case 'title':
      default:
        return collate(titleSortKey(a.title), titleSortKey(b.title))
    }
  })
}

export function Library() {
  const auth = useAuth()
  const {
    search,
    setSearch,
    sortBy,
    setSortBy,
    viewMode,
    setViewMode,
    statusFilter,
    setStatusFilter,
    needsAttentionOnly,
    setNeedsAttentionOnly,
    scrollYRef,
  } = useLibraryView()

  // Locally hides a shelf entry the instant it's removed, rather than
  // waiting on (or forcing) a full re-fetch of the library + progress —
  // removal is a deliberate, infrequent action, so a small client-side
  // override set is simpler than restructuring the useAsync data flow.
  const [removedFromShelf, setRemovedFromShelf] = useState<Set<string>>(new Set())

  async function handleRemoveFromContinueListening(e: React.MouseEvent, bookId: string) {
    e.preventDefault() // don't follow the enclosing Link to the book
    e.stopPropagation()
    setRemovedFromShelf((prev) => new Set(prev).add(bookId))
    try {
      await removeFromContinueListening(auth.token, bookId)
    } catch {
      setRemovedFromShelf((prev) => {
        const next = new Set(prev)
        next.delete(bookId)
        return next
      })
    }
  }

  // Captures the scroll position exactly once, at the moment this page is
  // navigated away from (e.g. to play a book) — not on every scroll event,
  // since nothing needs it until then.
  useEffect(() => {
    return () => {
      scrollYRef.current = window.scrollY
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const result = useAsync(async () => {
    const [books, progressEntries] = await Promise.all([
      fetchBooks().then((rows) => rows.map(adaptBookListItem)),
      reconcileAllProgress(auth.token),
    ])

    const byBookId = new Map(books.map((b) => [b.id, b]))
    const progressByBookId = new Map(progressEntries.map((p) => [p.bookId, p]))
    const continueListening = progressEntries
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => byBookId.get(p.bookId))
      .filter((b): b is Book => b !== undefined)

    return { books, continueListening, progressByBookId }
  }, [])

  const filteredBooks = useMemo(() => {
    if (result.status !== 'success') return []
    const { books, progressByBookId } = result.data
    const query = search.trim().toLowerCase()

    return books.filter((b) => {
      if (query && !b.title.toLowerCase().includes(query) && !b.author.toLowerCase().includes(query)) return false
      if (needsAttentionOnly && b.status !== 'missing') return false
      if (statusFilter !== 'all' && bookStatus(b, progressByBookId.get(b.id)) !== statusFilter) return false
      return true
    })
  }, [result, search, statusFilter, needsAttentionOnly])

  const visibleBooks = useMemo(() => sortBooks(filteredBooks, sortBy), [filteredBooks, sortBy])

  // Author browse fixes its own ordering (group by author, series-then-title
  // within group) rather than the sort dropdown — grouping already
  // establishes an order across authors, so the dropdown's options don't
  // map cleanly onto "what order do groups/books appear in" the way they do
  // for the flat list.
  const authorGroups = useMemo(() => groupByAuthor(filteredBooks), [filteredBooks])
  const seriesGroups = useMemo(() => groupBySeries(filteredBooks), [filteredBooks])

  // Restores the scroll position captured above, once the book grid has
  // actually rendered (not before — restoring against an empty "Loading…"
  // page would just scroll back to the top again once content arrives).
  // useLayoutEffect rather than useEffect so it applies before the browser
  // paints this render, avoiding a visible flash at the top first.
  useLayoutEffect(() => {
    if (result.status !== 'success') return
    window.scrollTo(0, scrollYRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.status])

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-slate-50">Your Library</h1>

      {result.status === 'loading' && <p className="text-center text-slate-400">Loading your library…</p>}

      {result.status === 'error' && <LibraryError onRetry={result.retry} />}

      {result.status === 'success' && result.data.books.length === 0 && (
        <p className="px-2 text-center text-slate-400">
          No books yet — add a source and scan it to start building your library.
        </p>
      )}

      {result.status === 'success' &&
        (() => {
          const continueListening = result.data.continueListening.filter((b) => !removedFromShelf.has(b.id))
          if (continueListening.length === 0) return null
          return (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-400">
                Continue Listening
              </h2>
              <ul className="flex gap-3 overflow-x-auto pb-1">
                {continueListening.map((book) => (
                  <li key={book.id} className="relative w-28 shrink-0">
                    <button
                      onClick={(e) => void handleRemoveFromContinueListening(e, book.id)}
                      aria-label={`Remove ${book.title} from Continue Listening`}
                      className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-slate-950/80 text-xs text-slate-300"
                    >
                      ✕
                    </button>
                    <Link to={`/book/${book.id}`}>
                      <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
                      <p className="mt-1 truncate text-xs text-slate-300">{book.title}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        })()}

      {result.status === 'success' && result.data.books.length > 0 && (
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-medium uppercase tracking-wide text-slate-400">
              All Books · {filteredBooks.length}
            </h2>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or author"
              className="w-full flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 sm:w-auto"
            />
            <div className="flex overflow-hidden rounded-lg border border-slate-700 text-sm">
              <button
                onClick={() => setViewMode('list')}
                className={`px-3 py-1.5 ${viewMode === 'list' ? 'bg-amber-400 text-slate-950' : 'bg-slate-900 text-slate-300'}`}
              >
                List
              </button>
              <button
                onClick={() => setViewMode('byAuthor')}
                className={`px-3 py-1.5 ${viewMode === 'byAuthor' ? 'bg-amber-400 text-slate-950' : 'bg-slate-900 text-slate-300'}`}
              >
                By Author
              </button>
              <button
                onClick={() => setViewMode('bySeries')}
                className={`px-3 py-1.5 ${viewMode === 'bySeries' ? 'bg-amber-400 text-slate-950' : 'bg-slate-900 text-slate-300'}`}
              >
                By Series
              </button>
            </div>
            {viewMode === 'list' && (
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
              >
                {(Object.entries(SORT_LABELS) as [SortOption, string][]).map(([value, label]) => (
                  <option key={value} value={value}>
                    Sort: {label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-slate-700 text-xs">
              {(Object.entries(STATUS_LABELS) as [StatusFilter, string][]).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setStatusFilter(value)}
                  className={`px-2.5 py-1.5 ${statusFilter === value ? 'bg-amber-400 text-slate-950' : 'bg-slate-900 text-slate-300'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setNeedsAttentionOnly((v) => !v)}
              className={`rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs ${
                needsAttentionOnly ? 'bg-red-600/90 text-white' : 'bg-slate-900 text-slate-300'
              }`}
            >
              Needs attention
            </button>
          </div>

          {filteredBooks.length === 0 ? (
            <p className="px-2 text-center text-slate-400">
              {search ? `No books match "${search}".` : 'No books match these filters.'}
            </p>
          ) : viewMode === 'list' ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
              {visibleBooks.map((book) => (
                <li key={book.id}>
                  <BookTile book={book} />
                </li>
              ))}
            </ul>
          ) : viewMode === 'byAuthor' ? (
            <div className="space-y-6">
              {authorGroups.map((group) => {
                const total = group.seriesGroups.reduce((sum, s) => sum + s.books.length, 0) + group.standalone.length
                return (
                  <div key={group.author}>
                    <h3 className="mb-2 text-sm font-medium text-slate-300">
                      {group.author} · {total}
                    </h3>
                    <div className="space-y-4">
                      {group.seriesGroups.map((seriesGroup) => (
                        <div key={seriesGroup.seriesName}>
                          <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
                            {seriesGroup.seriesName} · {seriesGroup.books.length}
                          </h4>
                          <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
                            {seriesGroup.books.map((book) => (
                              <li key={book.id}>
                                <BookTile book={book} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                      {group.standalone.length > 0 && (
                        <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
                          {group.standalone.map((book) => (
                            <li key={book.id}>
                              <BookTile book={book} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="space-y-6">
              {seriesGroups.series.map((group) => (
                <div key={group.seriesName}>
                  <h3 className="mb-2 text-sm font-medium text-slate-300">
                    {group.seriesName} · {group.books.length}
                  </h3>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
                    {group.books.map((book) => (
                      <li key={book.id}>
                        <BookTile book={book} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {seriesGroups.standalone.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-slate-300">
                    Not part of a series · {seriesGroups.standalone.length}
                  </h3>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
                    {seriesGroups.standalone.map((book) => (
                      <li key={book.id}>
                        <BookTile book={book} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
