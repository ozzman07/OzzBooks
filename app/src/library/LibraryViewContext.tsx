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
