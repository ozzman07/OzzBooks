import { lazy, Suspense } from 'react'
import { useParams } from 'react-router-dom'
import { useAppData } from '../data/AppDataContext'

// Lazy-loaded — epub.js (+jszip, lodash, xmldom) adds well over 100KB
// gzipped, same reasoning App.tsx used to apply to EbookReader directly.
// ComicReader is lazy too, for the same reason on its own smaller scale.
const EbookReader = lazy(() => import('./EbookReader').then((m) => ({ default: m.EbookReader })))
const ComicReader = lazy(() => import('./ComicReader').then((m) => ({ default: m.ComicReader })))

const READER_LOADING_STYLE = { background: '#F2F0E9', color: '#1A1A1A' }

const loadingFallback = (
  <div className="fixed inset-0 flex items-center justify-center text-sm" style={READER_LOADING_STYLE}>
    Loading…
  </div>
)

/**
 * /book/:bookId/read is one route mounting two very different readers —
 * dispatches to EbookReader (epub) or ComicReader (cbz) based on the
 * book's own format, mirroring how BookDetail already branches its
 * primary action button the same way (format === 'epub' vs 'cbz').
 *
 * Looks up the format from AppDataContext's already-loaded catalog rather
 * than making its own fetchBook call — that catalog is stale-while-
 * revalidate and IndexedDB-cached for offline resilience (see
 * catalogCacheStore.ts) already; a fresh, uncached fetch here would
 * otherwise be the one thing standing between a fully offline-downloaded
 * comic and actually being able to open it. Confirmed live: with the
 * network unreachable, the previous fetchBook-based version hung on
 * "Loading…" forever even though the comic itself was fully cached and
 * ComicReader's own cache-first page resolution was ready to serve it.
 */
export function BookReaderRoute() {
  const { bookId } = useParams()
  const data = useAppData()

  if (data.status === 'loading') return loadingFallback

  const book = bookId ? data.books.find((b) => b.id === bookId) : undefined
  if (!book) {
    // By this point data.status is 'success' or 'error' (the 'loading'
    // case already returned above) — either way, data.books reflects
    // everything currently known (fresh or cached), so there's nothing
    // left to wait for if the id genuinely isn't in it.
    return (
      <div className="fixed inset-0 flex items-center justify-center text-sm" style={READER_LOADING_STYLE}>
        Couldn't load this book.
      </div>
    )
  }

  const format = book.format === 'cbz' ? 'cbz' : 'epub'
  return <Suspense fallback={loadingFallback}>{format === 'cbz' ? <ComicReader /> : <EbookReader />}</Suspense>
}
