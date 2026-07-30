import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { reconcileAllProgress, removeFromContinueListening } from '../offline/reconcile'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { useAppData } from '../data/AppDataContext'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { formatDuration } from '../lib/format'
import { bookInLibrary } from '../library/companion'
import type { Book } from '../types'
import type { LocalProgressEntry } from '../offline/db'
import {
  useLibraryView,
  type SortOption,
  type StatusFilter,
  type FormatFilter,
  type DisplayMode,
  type LibraryViewMode,
} from '../library/LibraryViewContext'

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

const FORMAT_LABELS: Record<FormatFilter, string> = {
  all: 'All',
  audio: '🎧 Audio',
  ebook: '📖 Ebook',
}

const LIBRARY_VIEW_LABELS: Record<LibraryViewMode, string> = {
  mine: 'My Library',
  store: 'Store',
}

function isAudioFormat(book: Book): boolean {
  return book.format === 'm4b' || book.format === 'mp3_folder'
}

// A companion pair (an audiobook and an ebook linked to each other — see
// companionLink.ts server-side) exists as two separate book rows, one per
// format. Shown as a single tile with a combo badge rather than two
// separate tiles for what a person thinks of as one book: drops the
// ebook-side row whenever its audio companion is also in this list, which
// then carries both badges instead.
function dedupeCompanionPairs(books: Book[]): Book[] {
  const audioIds = new Set(books.filter(isAudioFormat).map((b) => b.id))
  return books.filter((b) => !(b.format === 'epub' && b.companionBookId && audioIds.has(b.companionBookId)))
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

// Shown on every tile/row, not just the ebook-capable exceptions, per the
// user's explicit ask — a badge that only appears sometimes reads as an
// error state at a glance; always showing one makes "what can I do with
// this book" consistent to scan across a mixed audio/ebook library.
function FormatBadge({ book, className = '' }: { book: Book; className?: string }) {
  const hasAudio = isAudioFormat(book)
  const hasEbook = book.format === 'epub' || Boolean(book.companionBookId)
  return (
    <span className={`whitespace-nowrap ${className}`} title={hasAudio && hasEbook ? 'Audiobook + ebook' : hasAudio ? 'Audiobook' : 'Ebook'}>
      {hasAudio && '🎧'}
      {hasEbook && '📖'}
    </span>
  )
}

// Only rendered in Store mode (see BookGrid) — lets someone shelve a book
// straight from the grid without drilling into BookDetail first. Sits
// outside the tile/row's own <Link> (same pattern as the existing
// Continue Listening ✕ button) so tapping it doesn't also navigate.
function LibraryToggleButton({
  inMyLibrary,
  onToggle,
  className,
}: {
  inMyLibrary: boolean
  onToggle: (e: React.MouseEvent) => void
  className: string
}) {
  return (
    <button
      onClick={onToggle}
      aria-label={inMyLibrary ? 'Remove from My Library' : 'Add to My Library'}
      title={inMyLibrary ? 'Remove from My Library' : 'Add to My Library'}
      className={className}
    >
      {inMyLibrary ? '✓' : '+'}
    </button>
  )
}

function BookTile({
  book,
  inMyLibrary,
  onToggleLibrary,
}: {
  book: Book
  inMyLibrary?: boolean
  onToggleLibrary?: (e: React.MouseEvent) => void
}) {
  return (
    <Link to={`/book/${book.id}`} className="block">
      <div className="relative">
        <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
        <FormatBadge
          book={book}
          className="absolute right-1 top-1 rounded bg-slate-950/70 px-1 py-0.5 text-xs leading-none text-white"
        />
        {onToggleLibrary && (
          <LibraryToggleButton
            inMyLibrary={inMyLibrary ?? false}
            onToggle={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleLibrary(e)
            }}
            className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-950/70 text-xs text-white"
          />
        )}
      </div>
      <p className="mt-1 truncate text-sm text-primary">{book.title}</p>
      <p className="truncate text-xs text-muted">{book.author}</p>
      <p className="text-xs text-subtle">{formatDuration(book.totalDuration)}</p>
    </Link>
  )
}

function BookRow({
  book,
  inMyLibrary,
  onToggleLibrary,
}: {
  book: Book
  inMyLibrary?: boolean
  onToggleLibrary?: (e: React.MouseEvent) => void
}) {
  return (
    <Link to={`/book/${book.id}`} className="flex items-center gap-3 py-2">
      <div className="w-12 shrink-0">
        <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm text-primary">
          <FormatBadge book={book} className="text-xs" />
          {book.title}
        </p>
        <p className="truncate text-xs text-muted">
          {book.author}
          {book.seriesName && (
            <span className="text-subtle">
              {' '}
              · {book.seriesName}
              {book.seriesNumber !== undefined && ` #${book.seriesNumber}`}
            </span>
          )}
        </p>
        {book.synopsis && <p className="line-clamp-2 text-xs text-subtle">{book.synopsis}</p>}
      </div>
      {onToggleLibrary && (
        <LibraryToggleButton
          inMyLibrary={inMyLibrary ?? false}
          onToggle={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggleLibrary(e)
          }}
          className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-secondary"
        />
      )}
      <p className="shrink-0 text-xs text-subtle">{formatDuration(book.totalDuration)}</p>
    </Link>
  )
}

function BookGrid({
  books,
  displayMode,
  myLibraryIds,
  onToggleLibrary,
}: {
  books: Book[]
  displayMode: DisplayMode
  /** Only passed in Store mode — presence (even an empty Set) is what turns on the add/remove affordance. */
  myLibraryIds?: Set<string>
  onToggleLibrary?: (book: Book, currentlyIn: boolean) => void
}) {
  const showToggle = myLibraryIds !== undefined && onToggleLibrary !== undefined
  if (displayMode === 'row') {
    return (
      <ul className="divide-y divide-border">
        {books.map((book) => (
          <li key={book.id}>
            <BookRow
              book={book}
              inMyLibrary={myLibraryIds ? bookInLibrary(book, myLibraryIds) : undefined}
              onToggleLibrary={
                showToggle ? () => onToggleLibrary!(book, bookInLibrary(book, myLibraryIds!)) : undefined
              }
            />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
      {books.map((book) => (
        <li key={book.id}>
          <BookTile
            book={book}
            inMyLibrary={myLibraryIds ? bookInLibrary(book, myLibraryIds) : undefined}
            onToggleLibrary={
              showToggle ? () => onToggleLibrary!(book, bookInLibrary(book, myLibraryIds!)) : undefined
            }
          />
        </li>
      ))}
    </ul>
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
  const location = useLocation()
  const data = useAppData()
  // "My Library" and "Store" are two routes sharing this one component
  // (/library, /store — see App.tsx) rather than a toggle within a single
  // page, so the bottom nav can surface Store as its own always-visible
  // tab. Derived from the URL rather than stored as its own piece of
  // context state, since the URL is already the source of truth for which
  // page this is.
  const libraryViewMode: LibraryViewMode = location.pathname === '/store' ? 'store' : 'mine'
  const {
    search,
    setSearch,
    sortBy,
    setSortBy,
    viewMode,
    setViewMode,
    displayMode,
    setDisplayMode,
    statusFilter,
    setStatusFilter,
    formatFilter,
    setFormatFilter,
    scrollPositionsRef,
  } = useLibraryView()

  // Locally hides a shelf entry the instant it's removed, rather than
  // waiting on (or forcing) a full re-fetch of progress — removal is a
  // deliberate, infrequent action, so a small client-side override set is
  // simpler than restructuring the useAsync data flow.
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

  async function handleToggleLibrary(book: Book, currentlyIn: boolean) {
    await data.toggleLibraryMembership(book, !currentlyIn)
  }

  // Captures the scroll position exactly once, at the moment this page is
  // navigated away from (e.g. to play a book, or to the other of
  // /library|/store — switching between those two fully unmounts and
  // remounts this component, same as leaving to any other page) — not on
  // every scroll event, since nothing needs it until then. Keyed by
  // pathname so /library and /store each keep their own remembered
  // position instead of clobbering each other's.
  useEffect(() => {
    const pathname = location.pathname
    return () => {
      scrollPositionsRef.current.set(pathname, window.scrollY)
    }
  }, [location.pathname, scrollPositionsRef])

  // The book list and shelf come from AppDataContext (fetched once per app
  // session, shared across every page) — this only fetches progress, which
  // is still per-mount (see the caching plan's explicit scope cut: it's a
  // much lighter payload, and it changes during live playback in a way the
  // book/shelf cache doesn't need to reason about).
  const progressResult = useAsync(() => reconcileAllProgress(auth.token), [])

  // Missing books live exclusively on the Needs Attention page — filtered
  // out here (both /library and /store) so a book that needs relinking
  // never shows up as a dead tile/row in either grid.
  const activeBooks = useMemo(
    () => dedupeCompanionPairs(data.books.filter((b) => b.status === 'active')),
    [data.books],
  )

  // A companion pair's epub-side row is deduped out of `activeBooks`
  // above, but its progress can be keyed to *either* id (audio listening
  // is always the audio id; ebook reading is the epub's own id — see
  // BookDetail's read-navigation fix). Registering both ids against the
  // one displayed tile means a progress row for either format still
  // resolves to it.
  const canonicalBookFor = useMemo(() => {
    const map = new Map<string, Book>()
    for (const b of activeBooks) {
      map.set(b.id, b)
      if (b.companionBookId) map.set(b.companionBookId, b)
    }
    return map
  }, [activeBooks])

  const progressByBookId = useMemo(() => {
    if (progressResult.status !== 'success') return new Map<string, LocalProgressEntry>()
    return new Map(progressResult.data.map((p) => [p.bookId, p]))
  }, [progressResult])

  // Not yet filtered to shelf-only here — that happens at render time
  // against data.myLibraryIds, so a live Add/Remove toggle updates this
  // shelf without needing a full re-fetch.
  const continueListeningCandidates = useMemo(() => {
    if (progressResult.status !== 'success') return []
    return progressResult.data
      .slice()
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .map((p) => canonicalBookFor.get(p.bookId))
      .filter((b): b is Book => b !== undefined)
  }, [progressResult, canonicalBookFor])

  const filteredBooks = useMemo(() => {
    const query = search.trim().toLowerCase()

    return activeBooks.filter((b) => {
      if (query && !b.title.toLowerCase().includes(query) && !b.author.toLowerCase().includes(query)) return false
      if (statusFilter !== 'all' && bookStatus(b, progressByBookId.get(b.id)) !== statusFilter) return false
      if (formatFilter === 'audio' && !isAudioFormat(b)) return false
      if (formatFilter === 'ebook' && !(b.format === 'epub' || b.companionBookId)) return false
      if (libraryViewMode === 'mine' && !bookInLibrary(b, data.myLibraryIds)) return false
      return true
    })
  }, [activeBooks, search, statusFilter, formatFilter, libraryViewMode, data.myLibraryIds, progressByBookId])

  const visibleBooks = useMemo(() => sortBooks(filteredBooks, sortBy), [filteredBooks, sortBy])

  // Author browse fixes its own ordering (group by author, series-then-title
  // within group) rather than the sort dropdown — grouping already
  // establishes an order across authors, so the dropdown's options don't
  // map cleanly onto "what order do groups/books appear in" the way they do
  // for the flat list.
  const authorGroups = useMemo(() => groupByAuthor(filteredBooks), [filteredBooks])
  const seriesGroups = useMemo(() => groupBySeries(filteredBooks), [filteredBooks])

  // Spread onto every BookGrid call below — only in Store mode does the
  // Add/Remove My Library affordance make sense (in My Library mode,
  // everything shown is already added, so there's nothing to toggle).
  const storeToggleProps =
    libraryViewMode === 'store' ? { myLibraryIds: data.myLibraryIds, onToggleLibrary: handleToggleLibrary } : {}

  // Restores the scroll position captured above, once the book grid has
  // actually rendered (not before — restoring against an empty "Loading…"
  // page would just scroll back to the top again once content arrives).
  // useLayoutEffect rather than useEffect so it applies before the browser
  // paints this render, avoiding a visible flash at the top first.
  useLayoutEffect(() => {
    if (data.status !== 'success') return
    window.scrollTo(0, scrollPositionsRef.current.get(location.pathname) ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.status, location.pathname])

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary">
          {/* Echoes the bottom nav's own icon for this tab (🛍️/📚) — a
              second, glanceable confirmation of which page this is beyond
              the text, since Store and My Library otherwise share the
              exact same grid/toolbar layout. */}
          <span aria-hidden="true">{libraryViewMode === 'store' ? '🛍️' : '📚'}</span>
          {libraryViewMode === 'store' ? 'Store' : 'Your Library'}
        </h1>
        {/* Pull-to-refresh doesn't work in the installed PWA (only in a
            browser tab) — this is the escape hatch for "someone else just
            added a book on their own device and I want to see it now"
            without waiting on the 5-minute visibility-regain refetch. */}
        <button
          onClick={() => void data.refresh()}
          disabled={data.status === 'loading'}
          aria-label="Refresh"
          title="Refresh"
          className="text-sm text-muted underline disabled:opacity-40"
        >
          ↻ Refresh
        </button>
      </div>

      {data.status === 'loading' && <p className="text-center text-muted">Loading your library…</p>}

      {data.status === 'error' && <LibraryError onRetry={data.refresh} error={data.error} />}

      {data.status === 'success' && activeBooks.length === 0 && (
        <p className="px-2 text-center text-muted">
          No books yet — add a source and scan it to start building your library.
        </p>
      )}

      {data.status === 'success' &&
        (() => {
          const continueListening = continueListeningCandidates
            .filter((b) => !removedFromShelf.has(b.id))
            .filter((b) => bookInLibrary(b, data.myLibraryIds))
          if (continueListening.length === 0) return null
          return (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">
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
                      <p className="mt-1 truncate text-xs text-secondary">{book.title}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )
        })()}

      {data.status === 'success' && activeBooks.length > 0 && (
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-medium uppercase tracking-wide text-muted">
              {LIBRARY_VIEW_LABELS[libraryViewMode]} · {filteredBooks.length}
            </h2>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or author"
              className="w-full rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary placeholder:text-subtle sm:w-auto sm:flex-1"
            />
            <div className="flex overflow-hidden rounded-lg border border-border-strong text-sm">
              <button
                onClick={() => setViewMode('list')}
                className={`px-3 py-1.5 ${viewMode === 'list' ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
              >
                List
              </button>
              <button
                onClick={() => setViewMode('byAuthor')}
                className={`px-3 py-1.5 ${viewMode === 'byAuthor' ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
              >
                By Author
              </button>
              <button
                onClick={() => setViewMode('bySeries')}
                className={`px-3 py-1.5 ${viewMode === 'bySeries' ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
              >
                By Series
              </button>
            </div>
            <div className="flex overflow-hidden rounded-lg border border-border-strong text-sm">
              <button
                onClick={() => setDisplayMode('tile')}
                className={`px-3 py-1.5 ${displayMode === 'tile' ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
              >
                Tiles
              </button>
              <button
                onClick={() => setDisplayMode('row')}
                className={`px-3 py-1.5 ${displayMode === 'row' ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
              >
                Rows
              </button>
            </div>
            {viewMode === 'list' && (
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="rounded-lg border border-border-strong bg-surface px-2 py-1.5 text-sm text-primary"
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
            <div className="flex overflow-hidden rounded-lg border border-border-strong text-xs">
              {(Object.entries(STATUS_LABELS) as [StatusFilter, string][]).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setStatusFilter(value)}
                  className={`px-2.5 py-1.5 ${statusFilter === value ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex overflow-hidden rounded-lg border border-border-strong text-xs">
              {(Object.entries(FORMAT_LABELS) as [FormatFilter, string][]).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFormatFilter(value)}
                  className={`px-2.5 py-1.5 ${formatFilter === value ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {filteredBooks.length === 0 ? (
            <p className="px-2 text-center text-muted">
              {search
                ? `No books match "${search}".`
                : libraryViewMode === 'mine'
                  ? 'Nothing on your shelf yet — check the Store tab to browse and add books.'
                  : 'No books match these filters.'}
            </p>
          ) : viewMode === 'list' ? (
            <BookGrid books={visibleBooks} displayMode={displayMode} {...storeToggleProps} />
          ) : viewMode === 'byAuthor' ? (
            <div className="space-y-6">
              {authorGroups.map((group) => {
                const total = group.seriesGroups.reduce((sum, s) => sum + s.books.length, 0) + group.standalone.length
                return (
                  <div key={group.author}>
                    <h3 className="mb-2 text-sm font-medium text-secondary">
                      {group.author} · {total}
                    </h3>
                    <div className="space-y-4">
                      {group.seriesGroups.map((seriesGroup) => (
                        <div key={seriesGroup.seriesName}>
                          <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-subtle">
                            {seriesGroup.seriesName} · {seriesGroup.books.length}
                          </h4>
                          <BookGrid books={seriesGroup.books} displayMode={displayMode} {...storeToggleProps} />
                        </div>
                      ))}
                      {group.standalone.length > 0 && (
                        <BookGrid books={group.standalone} displayMode={displayMode} {...storeToggleProps} />
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
                  <h3 className="mb-2 text-sm font-medium text-secondary">
                    {group.seriesName} · {group.books.length}
                  </h3>
                  <BookGrid books={group.books} displayMode={displayMode} {...storeToggleProps} />
                </div>
              ))}
              {seriesGroups.standalone.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-secondary">
                    Not part of a series · {seriesGroups.standalone.length}
                  </h3>
                  <BookGrid books={seriesGroups.standalone} displayMode={displayMode} {...storeToggleProps} />
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
