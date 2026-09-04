import { useMemo } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAppData } from '../data/AppDataContext'
import { BookGrid } from '../components/BookGrid'
import { LibraryError } from '../components/LibraryError'
import { bookInLibrary } from '../library/companion'
import { dedupeCompanionPairs, compareWithinSeries } from '../library/bookOrganize'
import { useLibraryView, type LibraryViewMode } from '../library/LibraryViewContext'

/**
 * Level 2 of the comics By Series view (see Library.tsx's series-cards
 * Level 1) — a real book grid for one series, reached by tapping its card.
 * Not comics-specific in its own logic (series_name is a plain column on
 * every format), just reached from the comics side today since the
 * audiobook By Series view still inline-expands directly. Ordered by the
 * same fallback chain as the rest of the app: series_number when one of
 * tag/folder/manual supplied it, else title — never assumes a strict
 * numeric sequence exists.
 */
export function SeriesDetail() {
  const { seriesName: encodedSeriesName } = useParams()
  const location = useLocation()
  const data = useAppData()
  const { displayMode } = useLibraryView()

  const seriesName = decodeURIComponent(encodedSeriesName ?? '')
  // Same route-derives-mode pattern as Library.tsx — /store/series/:name
  // vs /library/series/:name.
  const libraryViewMode: LibraryViewMode = location.pathname.startsWith('/store') ? 'store' : 'mine'
  const backHref = libraryViewMode === 'store' ? '/store' : '/library'

  const seriesBooks = useMemo(() => {
    const active = dedupeCompanionPairs(data.books.filter((b) => b.status === 'active' && b.seriesName === seriesName))
    const scoped = libraryViewMode === 'mine' ? active.filter((b) => bookInLibrary(b, data.myLibraryIds)) : active
    return scoped.slice().sort(compareWithinSeries)
  }, [data.books, data.myLibraryIds, seriesName, libraryViewMode])

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6">
      <Link to={backHref} className="mb-4 inline-block text-sm text-muted underline">
        ← Back
      </Link>

      {data.status === 'error' && <LibraryError onRetry={data.refresh} error={data.error} />}

      {data.status !== 'error' && (
        <>
          <h1 className="mb-4 text-2xl font-semibold text-primary">
            {seriesName} · {seriesBooks.length}
          </h1>
          {seriesBooks.length === 0 ? (
            <p className="px-2 text-center text-muted">
              {libraryViewMode === 'mine'
                ? 'Nothing from this series on your shelf yet.'
                : 'No items found for this series.'}
            </p>
          ) : (
            <BookGrid books={seriesBooks} displayMode={displayMode} />
          )}
        </>
      )}
    </div>
  )
}
