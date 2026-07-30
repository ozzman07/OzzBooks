import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { fetchBooks } from '../api/client'
import { adaptBookListItem } from '../api/adapter'
import { fetchMyLibrary, addToLibrary, removeFromLibrary } from '../api/cloudClient'
import { useAuth } from '../auth/AuthContext'
import { companionLibraryIds } from '../library/companion'
import type { Book } from '../types'

type Status = 'loading' | 'error' | 'success'

interface AppDataContextValue {
  books: Book[]
  myLibraryIds: Set<string>
  status: Status
  error: unknown
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

// Only relevant to the visibility-regain refetch below — a manual refresh
// or a mutation-triggered invalidate always goes through regardless of
// how recently the last fetch happened.
const STALE_AFTER_MS = 5 * 60 * 1000

// Lives above <Routes> (see LibraryViewProvider for the same pattern) so
// the book list and shelf are fetched once per app session and reused
// across every navigation, instead of every page re-fetching the whole
// catalog on its own mount. See the "Shared data cache" plan for the full
// rationale — this was the actual cause of "flipping around the library
// feels slow."
export function AppDataProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const [books, setBooks] = useState<Book[]>([])
  const [myLibraryIds, setMyLibraryIds] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<unknown>(null)
  const lastFetchedAtRef = useRef<number | null>(null)

  // Unfiltered — the server already returns `status` per book, so pages
  // needing just 'active' or just 'missing' filter this client-side
  // rather than each fetching their own differently-filtered copy.
  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const [fetchedBooks, libraryItems] = await Promise.all([
        fetchBooks().then((rows) => rows.map(adaptBookListItem)),
        auth.token ? fetchMyLibrary(auth.token) : Promise.resolve([]),
      ])
      setBooks(fetchedBooks)
      setMyLibraryIds(new Set(libraryItems.map((i) => i.book_id)))
      lastFetchedAtRef.current = Date.now()
      setStatus('success')
    } catch (err) {
      setError(err)
      setStatus('error')
    }
  }, [auth.token])

  useEffect(() => {
    void load()
  }, [load])

  // Safety net for "left the PWA open for a while" staleness, without
  // polling while the app is actually in use — pull-to-refresh doesn't
  // work in the installed PWA (only in a browser tab), so this and the
  // manual refresh button are the only ways stale data ever gets fixed.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      const last = lastFetchedAtRef.current
      if (!last || Date.now() - last > STALE_AFTER_MS) void load()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
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
