import { useMemo } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAppData } from '../data/AppDataContext'
import { BookGrid } from '../components/BookGrid'
import { LibraryError } from '../components/LibraryError'
import { bookInLibrary } from '../library/companion'
import { dedupeCompanionPairs, groupComicsByArc, groupSeriesByAuthor } from '../library/bookOrganize'
import { useLibraryView, type LibraryViewMode } from '../library/LibraryViewContext'
import type { Book } from '../types'

/**
 * Level 2 of the comics By Series view (see Library.tsx's series-cards
 * Level 1) — a real book grid for one series, reached by tapping its card.
 * Not comics-specific in its own logic (series_name is a plain column on
 * every format), just reached from the comics side today since the
 * audiobook By Series view still inline-expands directly. Ordered by the
 * same fallback chain as the rest of the app: series_number when one of
 * tag/folder/manual supplied it, else title — never assumes a strict
 * numeric sequence exists.
 *
 * Comics get a further sub-grouping here: groupComicsByArc clusters items
 * that share a folder one level below the series (a story arc, a block of
 * weekly issues) under their own heading, rather than flattening a large
 * series into one long list of numbered files — see Ozzbooks_Addendum_Comics'
 * "Sub-headings within a series from deeper folder nesting" fast-follow.
 * A no-op for audio/ebook series, whose books never have an arcName.
 */
export function SeriesDetail() {
  const { seriesName: encodedSeriesName } = useParams()
  const location = useLocation()
  const data = useAppData()
  const { displayMode, setDisplayMode } = useLibraryView()

  const seriesName = decodeURIComponent(encodedSeriesName ?? '')
  // Same route-derives-mode pattern as Library.tsx — /store/series/:name
  // vs /library/series/:name.
  const libraryViewMode: LibraryViewMode = location.pathname.startsWith('/store') ? 'store' : 'mine'
  const backHref = libraryViewMode === 'store' ? '/store' : '/library'

  const seriesBooks = useMemo(() => {
    const active = dedupeCompanionPairs(data.books.filter((b) => b.status === 'active' && b.seriesName === seriesName))
    return libraryViewMode === 'mine' ? active.filter((b) => bookInLibrary(b, data.myLibraryIds)) : active
  }, [data.books, data.myLibraryIds, seriesName, libraryViewMode])

  // Ordering happens per-bucket inside groupComicsByArc (compareWithinSeries
  // within each arc and within standalone), not on seriesBooks itself.
  const { arcs, standalone } = useMemo(() => groupComicsByArc(seriesBooks), [seriesBooks])

  // Bulk "+ Add ... to My Library" — skips anything already shelved rather
  // than re-adding it, so it's safe to tap again after adding part of an
  // arc/series by hand. Only offered in Store mode; in My Library mode
  // `seriesBooks` is already filtered down to shelved books (see above),
  // so there'd never be anything left to add.
  async function addAllToLibrary(books: Book[]) {
    await Promise.all(
      books.filter((b) => !bookInLibrary(b, data.myLibraryIds)).map((b) => data.toggleLibraryMembership(b, true)),
    )
  }

  async function handleToggleLibrary(book: Book, currentlyIn: boolean) {
    await data.toggleLibraryMembership(book, !currentlyIn)
  }

  // Same convention as Library.tsx — only Store mode gets the per-tile
  // add/remove affordance; in My Library mode everything shown is already
  // shelved, so there's nothing to toggle.
  const storeToggleProps =
    libraryViewMode === 'store' ? { myLibraryIds: data.myLibraryIds, onToggleLibrary: handleToggleLibrary } : {}

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6">
      <Link to={backHref} className="mb-4 inline-block text-sm text-muted underline">
        ← Back
      </Link>

      {data.status === 'error' && <LibraryError onRetry={data.refresh} error={data.error} />}

      {data.status !== 'error' && (
        <>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-primary">
              {seriesName} · {seriesBooks.length}
            </h1>
            {seriesBooks.length > 0 && (
              <div className="flex shrink-0 overflow-hidden rounded-lg border border-border-strong text-sm">
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
            )}
          </div>
          {seriesBooks.length === 0 ? (
            <p className="px-2 text-center text-muted">
              {libraryViewMode === 'mine'
                ? 'Nothing from this series on your shelf yet.'
                : 'No items found for this series.'}
            </p>
          ) : arcs.length === 0 ? (
            // The common case — no folder nesting beyond the series itself,
            // so this renders exactly as it did before arc-grouping existed.
            // A safe no-op for comics (author is always "Unknown author"
            // there) — this only actually kicks in for a multi-author
            // audio/ebook series (continuation novels — James Bond being the
            // motivating case), where it sub-groups by author instead of
            // interleaving every author's books by seriesNumber/title alone.
            <>
              {libraryViewMode === 'store' && (
                <div className="mb-2 flex justify-end">
                  <button
                    onClick={() => void addAllToLibrary(standalone)}
                    className="text-xs text-amber-400 underline"
                  >
                    + Add series to My Library
                  </button>
                </div>
              )}
              {(() => {
                const authorGroups = groupSeriesByAuthor(standalone)
                if (!authorGroups) return <BookGrid books={standalone} displayMode={displayMode} {...storeToggleProps} />
                return (
                  <div className="space-y-4">
                    {authorGroups.map((authorGroup) => (
                      <div key={authorGroup.author}>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <h4 className="text-xs font-medium uppercase tracking-wide text-subtle">
                            {authorGroup.author} · {authorGroup.books.length}
                          </h4>
                          {libraryViewMode === 'store' && (
                            <button
                              onClick={() => void addAllToLibrary(authorGroup.books)}
                              className="shrink-0 text-xs text-amber-400 underline"
                            >
                              + Add to My Library
                            </button>
                          )}
                        </div>
                        <BookGrid books={authorGroup.books} displayMode={displayMode} {...storeToggleProps} />
                      </div>
                    ))}
                  </div>
                )
              })()}
            </>
          ) : (
            <div className="space-y-6">
              {standalone.length > 0 && (
                <div>
                  {libraryViewMode === 'store' && (
                    <div className="mb-2 flex justify-end">
                      <button
                        onClick={() => void addAllToLibrary(standalone)}
                        className="text-xs text-amber-400 underline"
                      >
                        + Add all to My Library
                      </button>
                    </div>
                  )}
                  <BookGrid books={standalone} displayMode={displayMode} {...storeToggleProps} />
                </div>
              )}
              {arcs.map((arc) => (
                <div key={arc.arcName}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-secondary">
                      {arc.arcName} · {arc.books.length}
                    </h3>
                    {libraryViewMode === 'store' && (
                      <button
                        onClick={() => void addAllToLibrary(arc.books)}
                        className="shrink-0 text-xs text-amber-400 underline"
                      >
                        + Add arc to My Library
                      </button>
                    )}
                  </div>
                  <BookGrid books={arc.books} displayMode={displayMode} {...storeToggleProps} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
