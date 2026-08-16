import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { fetchBooks } from '../api/client'
import { adaptBookListItem } from '../api/adapter'
import { fetchMyLibrary, addToLibrary, removeFromLibrary } from '../api/cloudClient'
import { useAuth } from '../auth/AuthContext'
import { companionLibraryIds } from '../library/companion'
import { getCachedCatalog, putCachedCatalog } from '../offline/catalogCacheStore'
import type { Book } from '../types'

type Status = 'loading' | 'error' | 'success'

interface AppDataContextValue {
  books: Book[]
  myLibraryIds: Set<string>
  status: Status
  error: unknown
  /** True whenever the most recent fetch attempt failed — independent of
   * `status`, which stays 'success' as long as there's *something* to
   * show (fresh or cached). Drives the offline banner. */
  isOffline: boolean
  /** Re-fetches both books and the shelf — what the manual refresh button
   * calls, and also usable as a `retry` for the "can't reach your
   * library" screen. */
  refresh: () => Promise<void>
  /** Same as refresh, but fire-and-forget — for mutation call sites that
   * don't want to await a full network round trip before moving on
   * (scan completion, relink confirm). */
  invalidate: () => void
  toggleLibraryMembership: (book: Pick<Book, 'id' | 'companionBookId'>, add: boolean) => Promise<void>
  updateCachedBook: (bookId: string, patch: Partial<Book>) => void
  removeCachedBook: (bookId: string) => void
}

const AppDataContext = createContext<AppDataContextValue | null>(null)

// Only relevant to the visibility-regain refetch below — a manual refresh,
// an `online` event, or a mutation-triggered invalidate always goes
// through regardless of how recently the last fetch happened.
const STALE_AFTER_MS = 5 * 60 * 1000

// Lives above <Routes> (see LibraryViewProvider for the same pattern) so
// the book list and shelf are fetched once per app session and reused
// across every navigation, instead of every page re-fetching the whole
// catalog on its own mount. See the "Shared data cache" plan for the full
// rationale — this was the actual cause of "flipping around the library
// feels slow." Also persists to IndexedDB (catalogCacheStore) and treats a
// failed fetch as "stale, not gone" whenever there's already something to
// show — see the "Offline resilience" plan: previously any fetch failure
// hard-blocked the whole app behind an error screen, even for a book
// that's fully downloaded and playable offline.
export function AppDataProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const [books, setBooks] = useState<Book[]>([])
  const [myLibraryIds, setMyLibraryIds] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<unknown>(null)
  const [isOffline, setIsOffline] = useState(false)
  const lastFetchedAtRef = useRef<number | null>(null)
  // Mirrors `books` — read inside `load()` instead of depending on
  // `books`/`books.length` directly, which would change `load`'s identity
  // on every successful fetch and re-trigger the mount effect that calls
  // it (an infinite refetch loop). Assigned synchronously at every
  // `setBooks` call site below rather than via its own `useEffect`: a
  // `useEffect`-synced ref lags a full render/commit cycle behind, and
  // against an unreachable host `fetch` rejects (connection refused)
  // faster than that cycle completes — `load()`'s catch block would read
  // a stale (pre-cache-seed) `booksRef.current` and wrongly hard-fail to
  // the full error screen even with cached books already in state.
  const booksRef = useRef<Book[]>([])

  // Unfiltered — the server already returns `status` per book, so pages
  // needing just 'active' or just 'missing' filter this client-side
  // rather than each fetching their own differently-filtered copy.
  const load = useCallback(async () => {
    // Don't hide already-visible content behind a spinner for what's
    // just a background refresh.
    if (booksRef.current.length === 0) setStatus('loading')
    try {
      const [fetchedBooks, libraryItems] = await Promise.all([
        fetchBooks().then((rows) => rows.map(adaptBookListItem)),
        auth.token ? fetchMyLibrary(auth.token) : Promise.resolve([]),
      ])
      booksRef.current = fetchedBooks
      setBooks(fetchedBooks)
      setMyLibraryIds(new Set(libraryItems.map((i) => i.book_id)))
      lastFetchedAtRef.current = Date.now()
      setIsOffline(false)
      setStatus('success')
    } catch (err) {
      setIsOffline(true)
      // Only a hard failure if there's truly nothing to fall back to —
      // otherwise keep showing what's already there (fresh from this
      // session, or seeded from catalogCache below) and just flag it
      // stale via isOffline.
      if (booksRef.current.length === 0) {
        setError(err)
        setStatus('error')
      }
    }
  }, [auth.token])

  // Seed from the persisted catalog cache before the network attempt even
  // starts — fixes a cold PWA launch while offline, where `books` would
  // otherwise start empty with nothing to show until (if ever) the
  // network call resolves.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cached = await getCachedCatalog()
      if (!cancelled && cached && booksRef.current.length === 0) {
        booksRef.current = cached.books
        setBooks(cached.books)
        setMyLibraryIds(new Set(cached.myLibraryIds))
        setStatus('success')
      }
      if (!cancelled) void load()
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  // Persists whenever the in-memory catalog actually has something worth
  // saving — covers the initial load and every mutation
  // (toggleLibraryMembership, updateCachedBook, removeCachedBook) from one
  // place, rather than each of them remembering to call this themselves.
  useEffect(() => {
    if (status !== 'success') return
    void putCachedCatalog(books, [...myLibraryIds])
  }, [books, myLibraryIds, status])

  // Safety nets for staleness, neither a background poll: regaining
  // visibility after 5+ minutes (pull-to-refresh doesn't work in the
  // installed PWA, only in a browser tab, so this and the manual refresh
  // button are the only ways stale data normally gets fixed), and
  // reconnecting — same pattern already used in offline/syncEngine.ts for
  // progress sync — so the offline banner clears promptly instead of
  // waiting up to 5 minutes.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      const last = lastFetchedAtRef.current
      if (!last || Date.now() - last > STALE_AFTER_MS) void load()
    }
    function onOnline() {
      void load()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onOnline)
    }
  }, [load])

  // Companion-aware (adds/removes both formats of a pair together),
  // optimistic with revert-on-failure — the single implementation
  // replacing what Library.tsx and BookDetail.tsx each used to do
  // separately with their own local override state.
  const toggleLibraryMembership = useCallback(
    async (book: Pick<Book, 'id' | 'companionBookId'>, add: boolean) => {
      if (!auth.token) return
      const ids = companionLibraryIds(book)
      setMyLibraryIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) {
          if (add) next.add(id)
          else next.delete(id)
        }
        return next
      })
      try {
        await Promise.all(
          ids.map((id) => (add ? addToLibrary(auth.token!, id) : removeFromLibrary(auth.token!, id))),
        )
      } catch {
        setMyLibraryIds((prev) => {
          const next = new Set(prev)
          for (const id of ids) {
            if (add) next.delete(id)
            else next.add(id)
          }
          return next
        })
      }
    },
    [auth.token],
  )

  const updateCachedBook = useCallback((bookId: string, patch: Partial<Book>) => {
    setBooks((prev) => prev.map((b) => (b.id === bookId ? { ...b, ...patch } : b)))
  }, [])

  const removeCachedBook = useCallback((bookId: string) => {
    setBooks((prev) => prev.filter((b) => b.id !== bookId))
  }, [])

  const invalidate = useCallback(() => {
    void load()
  }, [load])

  const value: AppDataContextValue = {
    books,
    myLibraryIds,
    status,
    error,
    isOffline,
    refresh: load,
    invalidate,
    toggleLibraryMembership,
    updateCachedBook,
    removeCachedBook,
  }

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
}

export function useAppData() {
  const ctx = useContext(AppDataContext)
  if (!ctx) throw new Error('useAppData must be used within an AppDataProvider')
  return ctx
}
