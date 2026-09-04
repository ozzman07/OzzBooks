import {
  createContext,
  useContext,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from 'react'

export type SortOption = 'title' | 'author' | 'series' | 'recent'
export type ViewMode = 'list' | 'byAuthor' | 'bySeries'
// Deliberately separate from ViewMode (which means grouping mode) — this is
// purely how each group of books renders, orthogonal to how they're grouped.
export type DisplayMode = 'tile' | 'row'
export type StatusFilter = 'all' | 'not-started' | 'in-progress' | 'finished'
// 'audio'/'ebook' mean "can listen to"/"can read" — not a strict partition,
// since a companion pair (see Library.tsx's dedup) satisfies both.
export type FormatFilter = 'all' | 'audio' | 'ebook'
// Sentinel for "books with nothing tagged for this facet" — a real filter
// value in its own right (checkable/countable like any genre or narrator),
// not just an empty-state message. Doubles as a "needs a tag" worklist per
// Jim's request (2026-08-16). Never a legal genre/narrator string itself
// (both are free text or a controlled list with no double-underscore
// values), so this can't collide with real data.
export const FACET_UNSET = '__unset__'
// 'mine' = only books explicitly added to this account's shelf (the
// default — what actually shows on Continue Listening too); 'store' =
// the full shared catalog, browsable/sample-able regardless of who
// scanned a book in. See the "My Library" plan for the full rationale.
export type LibraryViewMode = 'mine' | 'store'
// Orthogonal to LibraryViewMode (ownership) — which collection either
// route (My Library/Store) is browsing. See Ozzbooks_Addendum_Comics'
// Library & browsing UI section: a segmented control at the top of the
// existing Library/Store screens, not a new route or nav entry.
export type ContentType = 'books' | 'comics'
// Same idea, scoped to the Needs Attention (missing books) list — 'mine'
// keeps that list from growing as cluttered as the old unfiltered main
// grid once more people add their own sources; 'everyone' is there for
// whoever's actually responsible for fixing sources.
export type NeedsAttentionScope = 'mine' | 'everyone'

interface LibraryViewContextValue {
  contentType: ContentType
  /** Not a plain dispatch — also resets viewMode to the content type's own
   * default (List for books, By Series for comics), an explicit switch
   * rather than "whatever the last mode was." A bySeries-tuned mode is
   * close to useless for a mostly-standalone audio/ebook collection and
   * vice versa — see the addendum's Library & browsing UI section. */
  setContentType: (next: ContentType) => void
  search: string
  setSearch: Dispatch<SetStateAction<string>>
  sortBy: SortOption
  setSortBy: Dispatch<SetStateAction<SortOption>>
  viewMode: ViewMode
  setViewMode: Dispatch<SetStateAction<ViewMode>>
  displayMode: DisplayMode
  setDisplayMode: Dispatch<SetStateAction<DisplayMode>>
  statusFilter: StatusFilter
  setStatusFilter: Dispatch<SetStateAction<StatusFilter>>
  formatFilter: FormatFilter
  setFormatFilter: Dispatch<SetStateAction<FormatFilter>>
  // Multi-select facets (checkbox lists, not a single active value) — an
  // empty Set means "no filter applied," not "match nothing." Values are
  // either a real genre/narrator string or the FACET_UNSET sentinel.
  genreFilter: Set<string>
  setGenreFilter: Dispatch<SetStateAction<Set<string>>>
  narratorFilter: Set<string>
  setNarratorFilter: Dispatch<SetStateAction<Set<string>>>
  // Comics-mode facets — swap in for Genre/Narrator, which don't mean
  // anything for a comic (no narrator; genre optional/lower-value there).
  // Same FACET_UNSET-sentinel shape as genre/narrator.
  publisherFilter: Set<string>
  setPublisherFilter: Dispatch<SetStateAction<Set<string>>>
  writerFilter: Set<string>
  setWriterFilter: Dispatch<SetStateAction<Set<string>>>
  // Which source(s) a book came from — every book always has exactly one,
  // so unlike genre/narrator this facet has no FACET_UNSET option.
  sourceFilter: Set<string>
  setSourceFilter: Dispatch<SetStateAction<Set<string>>>
  needsAttentionScope: NeedsAttentionScope
  setNeedsAttentionScope: Dispatch<SetStateAction<NeedsAttentionScope>>
  /** A ref rather than state — scroll position only needs to be *read* once
   * (to restore it) and *written* once (on leaving the page), so tracking
   * it as state would just cause pointless re-renders on every scroll
   * event for no benefit. Keyed by pathname (not a single number) now that
   * "My Library" and "Store" are separate routes (/library, /store)
   * sharing the same Library component — each unmount/remount (switching
   * between them via the bottom nav) needs its own remembered position,
   * not one shared value that the other route's scrolling overwrites. */
  scrollPositionsRef: MutableRefObject<Map<string, number>>
}

const LibraryViewContext = createContext<LibraryViewContextValue | null>(null)

// Lives above <Routes> in App.tsx (see PlayerProvider for the same pattern)
// so it survives navigating away from and back to the Library page —
// React Router unmounts a route's own component/state on navigation, which
// otherwise reset every filter, sort, view mode, and the scroll position
// back to defaults every time you returned from playing something.
// Each content type's own sane default grouping — comics is series-first
// (67 franchise-organized folders covering most of the real library), the
// existing audio/ebook collection stays List (mostly-standalone today).
const DEFAULT_VIEW_MODE_FOR_CONTENT_TYPE: Record<ContentType, ViewMode> = {
  books: 'list',
  comics: 'bySeries',
}

export function LibraryViewProvider({ children }: { children: ReactNode }) {
  const [contentType, setContentTypeRaw] = useState<ContentType>('books')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('title')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [displayMode, setDisplayMode] = useState<DisplayMode>('tile')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all')
  const [genreFilter, setGenreFilter] = useState<Set<string>>(new Set())
  const [narratorFilter, setNarratorFilter] = useState<Set<string>>(new Set())
  const [publisherFilter, setPublisherFilter] = useState<Set<string>>(new Set())
  const [writerFilter, setWriterFilter] = useState<Set<string>>(new Set())
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set())
  const [needsAttentionScope, setNeedsAttentionScope] = useState<NeedsAttentionScope>('mine')
  const scrollPositionsRef = useRef(new Map<string, number>())

  function setContentType(next: ContentType) {
    setContentTypeRaw(next)
    setViewMode(DEFAULT_VIEW_MODE_FOR_CONTENT_TYPE[next])
    // Every active filter is cleared on switch, not just the ones whose
    // facet swaps away (genre/narrator vs publisher/writer) — Source and
    // Status stay offered as facets in both modes (per the addendum), but
    // a *selected* value carrying over silently is a real trap: Source in
    // particular is nearly guaranteed to differ between content types (a
    // comics source is never also an audio/ebook source), so a Source
    // filter picked while browsing Books would silently zero out Comics
    // (and vice versa) with no visible explanation — confirmed live, this
    // is exactly what happened the first time a freshly-scanned Comics
    // source got checked against a Source filter left on from Books.
    setStatusFilter('all')
    setFormatFilter('all')
    setGenreFilter(new Set())
    setNarratorFilter(new Set())
    setPublisherFilter(new Set())
    setWriterFilter(new Set())
    setSourceFilter(new Set())
    setSearch('')
  }

  const value: LibraryViewContextValue = {
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
    needsAttentionScope,
    setNeedsAttentionScope,
    scrollPositionsRef,
  }

  return <LibraryViewContext.Provider value={value}>{children}</LibraryViewContext.Provider>
}

export function useLibraryView() {
  const ctx = useContext(LibraryViewContext)
  if (!ctx) throw new Error('useLibraryView must be used within a LibraryViewProvider')
  return ctx
}
