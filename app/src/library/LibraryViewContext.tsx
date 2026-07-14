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
export type StatusFilter = 'all' | 'not-started' | 'in-progress' | 'finished'

interface LibraryViewContextValue {
  search: string
  setSearch: Dispatch<SetStateAction<string>>
  sortBy: SortOption
  setSortBy: Dispatch<SetStateAction<SortOption>>
  viewMode: ViewMode
  setViewMode: Dispatch<SetStateAction<ViewMode>>
  statusFilter: StatusFilter
  setStatusFilter: Dispatch<SetStateAction<StatusFilter>>
  needsAttentionOnly: boolean
  setNeedsAttentionOnly: Dispatch<SetStateAction<boolean>>
  /** A ref rather than state — scroll position only needs to be *read* once
   * (to restore it) and *written* once (on leaving the page), so tracking
   * it as state would just cause pointless re-renders on every scroll
   * event for no benefit. */
  scrollYRef: MutableRefObject<number>
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false)
  const scrollYRef = useRef(0)

  const value: LibraryViewContextValue = {
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
  }

  return <LibraryViewContext.Provider value={value}>{children}</LibraryViewContext.Provider>
}

export function useLibraryView() {
  const ctx = useContext(LibraryViewContext)
  if (!ctx) throw new Error('useLibraryView must be used within a LibraryViewProvider')
  return ctx
}
