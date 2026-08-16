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
// Same idea, scoped to the Needs Attention (missing books) list — 'mine'
// keeps that list from growing as cluttered as the old unfiltered main
// grid once more people add their own sources; 'everyone' is there for
// whoever's actually responsible for fixing sources.
export type NeedsAttentionScope = 'mine' | 'everyone'

interface LibraryViewContextValue {
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
export function LibraryViewProvider({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('title')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [displayMode, setDisplayMode] = useState<DisplayMode>('tile')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all')
  const [genreFilter, setGenreFilter] = useState<Set<string>>(new Set())
  const [narratorFilter, setNarratorFilter] = useState<Set<string>>(new Set())
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set())
  const [needsAttentionScope, setNeedsAttentionScope] = useState<NeedsAttentionScope>('mine')
  const scrollPositionsRef = useRef(new Map<string, number>())

  const value: LibraryViewContextValue = {
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
