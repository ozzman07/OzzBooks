import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { reconcileAllProgress, removeFromContinueListening } from '../offline/reconcile'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { useAppData } from '../data/AppDataContext'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { BookGrid } from '../components/BookGrid'
import { bookInLibrary } from '../library/companion'
import {
  isAudioFormat,
  isComicFormat,
  dedupeCompanionPairs,
  bookStatus,
  isBookRead,
  collate,
  titleSortKey,
  collateByAuthor,
  compareBySeriesThenTitle,
  groupBySeries,
  groupByAuthor,
} from '../library/bookOrganize'
import type { Book } from '../types'
import type { LocalProgressEntry } from '../offline/db'
import {
  useLibraryView,
  FACET_UNSET,
  type SortOption,
  type StatusFilter,
  type FormatFilter,
  type LibraryViewMode,
} from '../library/LibraryViewContext'
import { FilterSheet, type FacetOption } from '../library/FilterSheet'
import { GENRE_OPTIONS } from '../library/genreOptions'

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

// Genre applies to every book, audio or ebook — a plain "is this value in
// the selected set" check (an empty selected set means the facet isn't
// active, so everything passes). Only used in Books mode.
function matchesGenreFacet(book: Book, selected: Set<string>): boolean {
  if (selected.size === 0) return true
  return selected.has(book.genre ?? FACET_UNSET)
}

// Narrator only means anything for audio — an active narrator filter must
// exclude ebooks entirely (they can't be "narrated by" anyone), not fold
// them into "Unset" alongside genuinely untagged audiobooks. That would
// flood the Unset bucket with ~every ebook in the library and defeat its
// point as a "needs a narrator tag" worklist. Only used in Books mode.
function matchesNarratorFacet(book: Book, selected: Set<string>): boolean {
  if (selected.size === 0) return true
  if (!isAudioFormat(book)) return false
  return selected.has(book.narrator ?? FACET_UNSET)
}

// Comics-mode counterparts — every comic could plausibly have a publisher/
// writer, so (unlike narrator) this doesn't need a format guard beyond the
// contentType split already applied before these run.
function matchesPublisherFacet(book: Book, selected: Set<string>): boolean {
  if (selected.size === 0) return true
  return selected.has(book.publisher ?? FACET_UNSET)
}

function matchesWriterFacet(book: Book, selected: Set<string>): boolean {
  if (selected.size === 0) return true
  return selected.has(book.writer ?? FACET_UNSET)
}

// Every book always has exactly one source — no FACET_UNSET case needed
// here, unlike genre/narrator.
function matchesSourceFacet(book: Book, selected: Set<string>): boolean {
  if (selected.size === 0) return true
  return book.sourceLabel !== undefined && selected.has(book.sourceLabel)
}

function toggleInSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

// Applied-filter pill shown outside the sheet once it's closed, so what's
// active stays visible/removable without reopening the whole panel.
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      onClick={onRemove}
      className="flex items-center gap-1 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs text-secondary"
    >
      {label}
      <span aria-hidden="true">✕</span>
    </button>
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
    contentType,
    setContentType,
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
    genreFilter,
    setGenreFilter,
    narratorFilter,
    setNarratorFilter,
    publisherFilter,
    setPublisherFilter,
    writerFilter,
    setWriterFilter,
    sourceFilter,
    setSourceFilter,
    scrollPositionsRef,
  } = useLibraryView()
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)

  // Locally hides a shelf entry the instant it's removed, rather than
  // waiting on (or forcing) a full re-fetch of progress — removal is a
  // deliberate, infrequent action, so a small client-side override set is
  // simpler than restructuring the useAsync data flow.
  const [removedFromShelf, setRemovedFromShelf] = useState<Set<string>>(new Set())

  // The manual Refresh button needs its own loading affordance — global
  // `data.status` only flips to 'loading' when there's nothing cached yet
  // (see AppDataContext's stale-while-revalidate `load()`), so a refresh
  // with an already-populated library would otherwise fetch silently with
  // no visible feedback that the click did anything.
  const [isRefreshing, setIsRefreshing] = useState(false)

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

  // Shared by both the actual filtered list and the facet-count computation
  // below — `exclude` skips one facet's own predicate so that facet's
  // counts reflect every *other* active filter without shrinking against
  // its own current selection (standard faceted-search behavior: checking
  // one Genre option shouldn't make the other Genre options' counts drop
  // to 0, since checking another one of them is still a valid next click).
  type Facet = 'status' | 'format' | 'genre' | 'narrator' | 'publisher' | 'writer' | 'source'
  function passesFilters(b: Book, exclude?: Facet): boolean {
    if (isComicFormat(b) !== (contentType === 'comics')) return false
    const query = search.trim().toLowerCase()
    if (
      query &&
      !b.title.toLowerCase().includes(query) &&
      !b.author.toLowerCase().includes(query) &&
      !(b.seriesName ?? '').toLowerCase().includes(query)
    )
      return false
    if (libraryViewMode === 'mine' && !bookInLibrary(b, data.myLibraryIds)) return false
    if (exclude !== 'status' && statusFilter !== 'all' && bookStatus(b, progressByBookId.get(b.id)) !== statusFilter)
      return false
    if (exclude !== 'format' && contentType === 'books') {
      if (formatFilter === 'audio' && !isAudioFormat(b)) return false
      if (formatFilter === 'ebook' && !(b.format === 'epub' || b.companionBookId)) return false
    }
    if (contentType === 'books') {
      if (exclude !== 'genre' && !matchesGenreFacet(b, genreFilter)) return false
      if (exclude !== 'narrator' && !matchesNarratorFacet(b, narratorFilter)) return false
    } else {
      if (exclude !== 'publisher' && !matchesPublisherFacet(b, publisherFilter)) return false
      if (exclude !== 'writer' && !matchesWriterFacet(b, writerFilter)) return false
    }
    if (exclude !== 'source' && !matchesSourceFacet(b, sourceFilter)) return false
    return true
  }

  const filteredBooks = useMemo(
    () => activeBooks.filter((b) => passesFilters(b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeBooks, contentType, search, statusFilter, formatFilter, genreFilter, narratorFilter, publisherFilter, writerFilter, sourceFilter, libraryViewMode, data.myLibraryIds, progressByBookId],
  )

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: 0, 'not-started': 0, 'in-progress': 0, finished: 0 }
    for (const b of activeBooks) {
      if (!passesFilters(b, 'status')) continue
      counts[bookStatus(b, progressByBookId.get(b.id))]++
      counts.all++
    }
    return counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBooks, contentType, search, formatFilter, genreFilter, narratorFilter, publisherFilter, writerFilter, sourceFilter, libraryViewMode, data.myLibraryIds, progressByBookId])

  const formatCounts = useMemo(() => {
    const counts: Record<FormatFilter, number> = { all: 0, audio: 0, ebook: 0 }
    for (const b of activeBooks) {
      if (!passesFilters(b, 'format')) continue
      counts.all++
      if (isAudioFormat(b)) counts.audio++
      if (b.format === 'epub' || b.companionBookId) counts.ebook++
    }
    return counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBooks, contentType, search, statusFilter, genreFilter, narratorFilter, publisherFilter, writerFilter, sourceFilter, libraryViewMode, data.myLibraryIds, progressByBookId])

  const genreOptions: FacetOption[] = useMemo(() => {
    const counts = new Map<string, number>()
    for (const b of activeBooks) {
      if (!passesFilters(b, 'genre')) continue
      const key = b.genre ?? FACET_UNSET
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const options: FacetOption[] = GENRE_OPTIONS.map((g) => ({ value: g, label: g, count: counts.get(g) ?? 0 })).filter(
      (o) => o.count > 0 || genreFilter.has(o.value),
    )
    options.push({ value: FACET_UNSET, label: 'Unset', count: counts.get(FACET_UNSET) ?? 0 })
    return options
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBooks, contentType, search, statusFilter, formatFilter, narratorFilter, sourceFilter, libraryViewMode, data.myLibraryIds, progressByBookId, genreFilter])

  const narratorOptions: FacetOption[] = useMemo(() => {
    const counts = new Map<string, number>()
    for (const b of activeBooks) {
      if (!isAudioFormat(b)) continue
      if (!passesFilters(b, 'narrator')) continue
      const key = b.narrator ?? FACET_UNSET
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    // Most-used narrators first — with a real library this can be 60+
    // people, and the ones you actually have several books from should
    // surface before alphabetical noise. Unset always pinned last: it's
    // the "needs attention" catch-all, not a narrator to browse toward.
    const entries = [...counts.entries()].filter(([key]) => key !== FACET_UNSET)
    entries.sort((a, b) => b[1] - a[1])
    const options: FacetOption[] = entries.map(([value, count]) => ({ value, label: value, count }))
    options.push({ value: FACET_UNSET, label: 'Unset', count: counts.get(FACET_UNSET) ?? 0 })
    return options
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBooks, contentType, search, statusFilter, formatFilter, genreFilter, sourceFilter, libraryViewMode, data.myLibraryIds, progressByBookId])

  // Comics-mode facets — same "most-used first, Unset pinned last" shape
  // as narrator above, since a real library can have dozens of publishers/
  // writers once the whole 3,440-file collection is scanned.
  const publisherOptions: FacetOption[] = useMemo(() => {
    const counts = new Map<string, number>()
    for (const b of activeBooks) {
      if (!passesFilters(b, 'publisher')) continue
      const key = b.publisher ?? FACET_UNSET
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const entries = [...counts.entries()].filter(([key]) => key !== FACET_UNSET)
    entries.sort((a, b) => b[1] - a[1])
    const options: FacetOption[] = entries.map(([value, count]) => ({ value, label: value, count }))
    options.push({ value: FACET_UNSET, label: 'Unset', count: counts.get(FACET_UNSET) ?? 0 })
    return options
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBooks, contentType, search, statusFilter, writerFilter, sourceFilter, libraryViewMode, data.myLibraryIds, progressByBookId])

  const writerOptions: FacetOption[] = useMemo(() => {
    const counts = new Map<string, number>()
    for (const b of activeBooks) {
      if (!passesFilters(b, 'writer')) continue
      const key = b.writer ?? FACET_UNSET
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const entries = [...counts.entries()].filter(([key]) => key !== FACET_UNSET)
    entries.sort((a, b) => b[1] - a[1])
    const options: FacetOption[] = entries.map(([value, count]) => ({ value, label: value, count }))
    options.push({ value: FACET_UNSET, label: 'Unset', count: counts.get(FACET_UNSET) ?? 0 })
    return options
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBooks, contentType, search, statusFilter, publisherFilter, sourceFilter, libraryViewMode, data.myLibraryIds, progressByBookId])

  const sourceOptions: FacetOption[] = useMemo(() => {
    const counts = new Map<string, number>()
    for (const b of activeBooks) {
      if (!passesFilters(b, 'source')) continue
      if (b.sourceLabel === undefined) continue
      counts.set(b.sourceLabel, (counts.get(b.sourceLabel) ?? 0) + 1)
    }
    const options: FacetOption[] = [...counts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return options
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBooks, contentType, search, statusFilter, formatFilter, genreFilter, narratorFilter, publisherFilter, writerFilter, libraryViewMode, data.myLibraryIds, progressByBookId])

  const visibleBooks = useMemo(() => sortBooks(filteredBooks, sortBy), [filteredBooks, sortBy])

  const activeFilterCount =
    (statusFilter !== 'all' ? 1 : 0) +
    (contentType === 'books'
      ? (formatFilter !== 'all' ? 1 : 0) + genreFilter.size + narratorFilter.size
      : publisherFilter.size + writerFilter.size) +
    sourceFilter.size

  function clearAllFilters() {
    setStatusFilter('all')
    setFormatFilter('all')
    setGenreFilter(new Set())
    setNarratorFilter(new Set())
    setPublisherFilter(new Set())
    setWriterFilter(new Set())
    setSourceFilter(new Set())
  }

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
          {libraryViewMode === 'store' ? 'OzzBooks Store' : 'Your Library'}
        </h1>
        {/* Pull-to-refresh doesn't work in the installed PWA (only in a
            browser tab) — this is the escape hatch for "someone else just
            added a book on their own device and I want to see it now"
            without waiting on the 5-minute visibility-regain refetch. */}
        <button
          onClick={() => {
            setIsRefreshing(true)
            void data.refresh().finally(() => setIsRefreshing(false))
          }}
          disabled={isRefreshing || data.status === 'loading'}
          aria-label="Refresh"
          title="Refresh"
          className="text-sm text-muted underline disabled:opacity-40"
        >
          {isRefreshing ? '↻ Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* Orthogonal to the My Library/Store route split above — scopes
          *which* collection either route browses. Sits just under the page
          title, above the search/sort/filter row, per the addendum's
          Library & browsing UI plan. */}
      <div className="mb-4 flex w-fit overflow-hidden rounded-lg border border-border-strong text-sm">
        <button
          onClick={() => setContentType('books')}
          className={`px-3 py-1.5 ${contentType === 'books' ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
        >
          📚 Books
        </button>
        <button
          onClick={() => setContentType('comics')}
          className={`px-3 py-1.5 ${contentType === 'comics' ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
        >
          💥 Comics
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
          // Partitioned by the active content-type toggle, same reason it's
          // already partitioned by bookInLibrary/removed-from-shelf below —
          // someone reopening Library to continue an audiobook shouldn't
          // see a mid-issue comic thumbnail interleaved with it.
          const continueListening = continueListeningCandidates
            .filter((b) => isComicFormat(b) === (contentType === 'comics'))
            .filter((b) => !removedFromShelf.has(b.id))
            .filter((b) => bookInLibrary(b, data.myLibraryIds))
          if (continueListening.length === 0) return null
          return (
            <section className="mb-6">
              {/* "In Progress," not "Continue Listening" — this shelf mixes
                  audio and ebook progress together (see the companion-pair
                  progress-resolution fix elsewhere in this file), so a
                  listening-specific name was actually wrong, not just
                  imprecise, once ebooks could land here too. */}
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">
                In Progress
              </h2>
              <ul className="flex gap-3 overflow-x-auto pb-1">
                {continueListening.map((book) => (
                  <li key={book.id} className="relative w-28 shrink-0">
                    <button
                      onClick={(e) => void handleRemoveFromContinueListening(e, book.id)}
                      aria-label={`Remove ${book.title} from In Progress`}
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
              placeholder={contentType === 'comics' ? 'Search title or series' : 'Search title, author, or series'}
              className="w-full rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm text-primary placeholder:text-subtle sm:w-auto sm:flex-1"
            />
          </div>

          {/* Every other control — view mode, display mode, sort, and the
              facet filters — shares this one row, rather than the filter
              button/chips sitting alone below looking disconnected from the
              rest of the toolbar. */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
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
            <button
              onClick={() => setFilterSheetOpen(true)}
              className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-xs text-secondary"
            >
              Filters
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-amber-400 px-1.5 text-slate-950">{activeFilterCount}</span>
              )}
            </button>
            {statusFilter !== 'all' && (
              <FilterChip label={STATUS_LABELS[statusFilter]} onRemove={() => setStatusFilter('all')} />
            )}
            {contentType === 'books' && formatFilter !== 'all' && (
              <FilterChip label={FORMAT_LABELS[formatFilter]} onRemove={() => setFormatFilter('all')} />
            )}
            {[...sourceFilter].map((s) => (
              <FilterChip key={s} label={s} onRemove={() => setSourceFilter((prev) => toggleInSet(prev, s))} />
            ))}
            {contentType === 'books' ? (
              <>
                {[...genreFilter].map((g) => (
                  <FilterChip
                    key={g}
                    label={g === FACET_UNSET ? 'Genre: Unset' : g}
                    onRemove={() => setGenreFilter((prev) => toggleInSet(prev, g))}
                  />
                ))}
                {[...narratorFilter].map((n) => (
                  <FilterChip
                    key={n}
                    label={n === FACET_UNSET ? 'Narrator: Unset' : n}
                    onRemove={() => setNarratorFilter((prev) => toggleInSet(prev, n))}
                  />
                ))}
              </>
            ) : (
              <>
                {[...publisherFilter].map((p) => (
                  <FilterChip
                    key={p}
                    label={p === FACET_UNSET ? 'Publisher: Unset' : p}
                    onRemove={() => setPublisherFilter((prev) => toggleInSet(prev, p))}
                  />
                ))}
                {[...writerFilter].map((w) => (
                  <FilterChip
                    key={w}
                    label={w === FACET_UNSET ? 'Writer: Unset' : w}
                    onRemove={() => setWriterFilter((prev) => toggleInSet(prev, w))}
                  />
                ))}
              </>
            )}
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
          ) : contentType === 'comics' ? (
            // Comics' By Series can't be the audiobook By Series view reused
            // verbatim — inline-expanding all 67 series' full grids on one
            // page doesn't hold up at this scale (up to ~3,440 tiles in one
            // unbroken scroll). Level 1 here is just series cards; tapping
            // one opens the real grid on its own Series Detail page.
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-4">
              {seriesGroups.series.map((group) => {
                const readCount = group.books.filter((b) => isBookRead(b, progressByBookId.get(b.id))).length
                return (
                  <Link
                    key={group.seriesName}
                    to={`${libraryViewMode === 'store' ? '/store' : '/library'}/series/${encodeURIComponent(group.seriesName)}`}
                    className="block"
                  >
                    <CoverArt title={group.seriesName} coverUrl={group.books[0]?.coverThumbUrl} />
                    <p className="mt-1 truncate text-sm text-primary">{group.seriesName}</p>
                    <p className="truncate text-xs text-muted">
                      {group.books.length} item{group.books.length === 1 ? '' : 's'}
                    </p>
                    <p className="truncate text-xs text-subtle">
                      {readCount} of {group.books.length} read
                    </p>
                  </Link>
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

          {/* Standalone/one-shot comics fold into a flat "Not part of a
              series" section below the series-cards grid, same convention
              groupBySeries already uses for a lone book — a real Book Detail
              grid, not another card level (there's nothing to drill into). */}
          {contentType === 'comics' && viewMode === 'bySeries' && seriesGroups.standalone.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-sm font-medium text-secondary">
                Not part of a series · {seriesGroups.standalone.length}
              </h3>
              <BookGrid books={seriesGroups.standalone} displayMode={displayMode} {...storeToggleProps} />
            </div>
          )}
        </section>
      )}

      <FilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        onClearAll={clearAllFilters}
        resultCount={filteredBooks.length}
        status={{
          value: statusFilter,
          onChange: setStatusFilter,
          options: (Object.entries(STATUS_LABELS) as [StatusFilter, string][]).map(([value, label]) => ({
            value,
            label,
            count: statusCounts[value],
          })),
        }}
        format={
          contentType === 'books'
            ? {
                value: formatFilter,
                onChange: setFormatFilter,
                options: (Object.entries(FORMAT_LABELS) as [FormatFilter, string][]).map(([value, label]) => ({
                  value,
                  label,
                  count: formatCounts[value],
                })),
              }
            : undefined
        }
        source={{
          selected: sourceFilter,
          onToggle: (value) => setSourceFilter((prev) => toggleInSet(prev, value)),
          options: sourceOptions,
          searchThreshold: 12,
        }}
        genre={
          contentType === 'books'
            ? { selected: genreFilter, onToggle: (value) => setGenreFilter((prev) => toggleInSet(prev, value)), options: genreOptions }
            : undefined
        }
        narrator={
          contentType === 'books'
            ? {
                selected: narratorFilter,
                onToggle: (value) => setNarratorFilter((prev) => toggleInSet(prev, value)),
                options: narratorOptions,
                searchThreshold: 12,
              }
            : undefined
        }
        publisher={
          contentType === 'comics'
            ? {
                selected: publisherFilter,
                onToggle: (value) => setPublisherFilter((prev) => toggleInSet(prev, value)),
                options: publisherOptions,
                searchThreshold: 12,
              }
            : undefined
        }
        writer={
          contentType === 'comics'
            ? {
                selected: writerFilter,
                onToggle: (value) => setWriterFilter((prev) => toggleInSet(prev, value)),
                options: writerOptions,
                searchThreshold: 12,
              }
            : undefined
        }
      />
    </div>
  )
}
