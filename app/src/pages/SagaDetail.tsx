import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAppData } from '../data/AppDataContext'
import { useAsync } from '../hooks/useAsync'
import { CoverArt } from '../components/CoverArt'
import { AddBooksToPlaylist } from '../components/AddBooksToPlaylist'
import { orderedSagaBooks } from '../library/bookOrganize'
import type { Book } from '../types'
import {
  fetchSaga,
  renameSaga,
  deleteSaga,
  addSeriesToSaga,
  reorderSagaSeries,
  removeSeriesFromSaga,
  ApiError,
  type ApiSagaDetail,
} from '../api/client'

// 'books' deliberately merges audio+ebook rather than splitting them —
// the Store/Library already combine a companion-linked audio+ebook pair
// into one card with both read/listen actions, so a per-format split here
// would be a finer distinction than the rest of the app draws. Per-series
// 🎧/📖/💥 icons (see seriesFormats below) still show the actual format
// mix within "Books," for whichever of those two this particular series
// actually has.
type ContentTypeFilter = 'all' | 'books' | 'comic'

/**
 * Data-entry only, deliberately not a book browser (see the saga design
 * conversation this was built from) — orders which series belong to a
 * saga and in what position, nothing more. Book-level details (counts,
 * covers) are derived client-side from AppDataContext's already-loaded
 * books, same as SeriesDetail.tsx does, rather than the server joining
 * them in — sagas.ts's own comment explains why.
 *
 * Modeled directly on PlaylistDetail.tsx's layout and interactions
 * (rename, delete, up/down reorder via a full-list replace) rather than
 * real drag-and-drop, for the same reason that page already made that
 * call: tap-to-swap is simpler to build and more reliable on mobile than
 * native HTML5 drag, which is flaky on iOS Safari.
 */
export function SagaDetail() {
  const { sagaName: encodedSagaName } = useParams()
  const navigate = useNavigate()
  const data = useAppData()

  const sagaName = decodeURIComponent(encodedSagaName ?? '')

  const [saga, setSaga] = useState<ApiSagaDetail | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [pickerFilter, setPickerFilter] = useState('')
  const [pickerContentType, setPickerContentType] = useState<ContentTypeFilter>('all')
  const [pickerSelection, setPickerSelection] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)

  const result = useAsync(() => fetchSaga(sagaName), [sagaName])

  useEffect(() => {
    if (result.status !== 'success') return
    setSaga(result.data)
    setNameDraft(result.data.saga_name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.status, sagaName])

  // Every format present in each series — drives both the picker's
  // content-type filter and the 🎧/📖/💥 icons next to each row, so "is
  // this the audio series or the ebook one" doesn't require opening it to
  // find out.
  const seriesFormats = useMemo(() => {
    const byName = new Map<string, Set<Book['format']>>()
    for (const book of data.books) {
      if (!book.seriesName) continue
      const formats = byName.get(book.seriesName) ?? new Set<Book['format']>()
      formats.add(book.format)
      byName.set(book.seriesName, formats)
    }
    return byName
  }, [data.books])

  // Every distinct series name in the library, for the "+ Add series"
  // picker — excludes series already in this saga (nothing to pick there)
  // and applies the picker's own search text and content-type filters, so
  // a large library stays scrollable instead of forcing an exact-match
  // search through every format at once.
  const pickerCandidates = useMemo(() => {
    const inThisSaga = new Set(saga?.series.map((s) => s.series_name) ?? [])
    const filter = pickerFilter.trim().toLowerCase()
    return [...seriesFormats.keys()]
      .filter((name) => !inThisSaga.has(name))
      .filter((name) => !filter || name.toLowerCase().includes(filter))
      .filter((name) => {
        if (pickerContentType === 'all') return true
        const formats = seriesFormats.get(name)!
        return pickerContentType === 'comic' ? formats.has('cbz') : formats.has('m4b') || formats.has('mp3_folder') || formats.has('epub')
      })
      .sort((a, b) => a.localeCompare(b))
  }, [seriesFormats, saga, pickerFilter, pickerContentType])

  const seriesInfo = useMemo(() => {
    const byName = new Map<string, { bookCount: number; coverUrl: string | undefined }>()
    for (const book of data.books) {
      if (!book.seriesName) continue
      const existing = byName.get(book.seriesName)
      if (existing) {
        existing.bookCount += 1
      } else {
        byName.set(book.seriesName, { bookCount: 1, coverUrl: book.coverThumbUrl })
      }
    }
    return byName
  }, [data.books])

  // For AddBooksToPlaylist — every book across the saga's member series,
  // in saga-then-series order.
  const sagaBooks = useMemo(
    () => orderedSagaBooks(data.books, saga?.series.map((s) => s.series_name) ?? []),
    [data.books, saga],
  )

  if (result.status === 'loading' || !saga) {
    return <p className="px-4 pt-24 text-center text-muted">Loading…</p>
  }
  if (result.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 px-6 pt-24 text-center text-muted">
        <p className="text-lg text-primary">Can't reach this saga right now</p>
        <button onClick={result.retry} className="mt-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950">
          Retry
        </button>
      </div>
    )
  }

  async function move(index: number, direction: -1 | 1) {
    if (!saga) return
    const series = saga.series.slice()
    const target = index + direction
    if (target < 0 || target >= series.length) return
    ;[series[index], series[target]] = [series[target], series[index]]
    setSaga({ ...saga, series }) // optimistic — a tap is deliberate and infrequent, not worth waiting on
    setActionError(null)
    try {
      const updated = await reorderSagaSeries(
        saga.saga_name,
        series.map((s) => s.series_name),
      )
      setSaga(updated)
      // Real bug caught live: sagaPosition is cached per-book in
      // AppDataContext (see Library.tsx/SeriesDetail.tsx/BookDetail.tsx's
      // own "Part of [saga], #N" badges), not re-derived from this page's
      // own state — without this, reordering here left every affected
      // book showing its old position everywhere else until some
      // unrelated refresh happened to reload the catalog.
      data.invalidate()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not reach the server')
      result.retry()
    }
  }

  async function removeSeries(seriesName: string) {
    if (!saga) return
    setActionError(null)
    const series = saga.series.filter((s) => s.series_name !== seriesName)
    setSaga({ ...saga, series })
    try {
      await removeSeriesFromSaga(saga.saga_name, seriesName)
      data.invalidate() // same reasoning as move() above
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not reach the server')
      result.retry()
    }
  }

  function togglePickerSelection(name: string) {
    setPickerSelection((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // Sequential, not Promise.all — the server assigns each new row's
  // position as "current max + 1" per request (see sagas.ts), so firing
  // these in parallel could let two inserts read the same max and collide
  // on position. Adds in the picker's own sorted order, so a multi-select
  // lands in a predictable (alphabetical) order the user can then
  // reorder from, rather than whatever order Set iteration happened to
  // produce.
  async function addSelectedSeries() {
    if (!saga || pickerSelection.size === 0) return
    setActionError(null)
    setAdding(true)
    try {
      const inOrder = pickerCandidates.filter((name) => pickerSelection.has(name))
      let updated = saga
      for (const name of inOrder) {
        updated = await addSeriesToSaga(saga.saga_name, name)
      }
      setSaga(updated)
      setPickerSelection(new Set())
      setPickerFilter('')
      setShowPicker(false)
      data.invalidate() // same reasoning as move() above
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not reach the server')
      result.retry()
    } finally {
      setAdding(false)
    }
  }

  async function saveRename() {
    if (!saga || !nameDraft.trim() || nameDraft.trim() === saga.saga_name) {
      setRenaming(false)
      return
    }
    setActionError(null)
    try {
      const updated = await renameSaga(saga.saga_name, nameDraft.trim())
      setRenaming(false)
      data.invalidate() // same reasoning as move() above — sagaName is cached per-book too
      // The saga's name is its own key (no separate id) — renaming moves
      // it to a new URL, same as the series-detail links elsewhere in the
      // app already encode seriesName directly into the path.
      navigate(`/sagas/${encodeURIComponent(updated.saga_name)}`, { replace: true })
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not reach the server')
    }
  }

  async function handleDelete() {
    if (!saga) return
    if (!window.confirm(`Delete the "${saga.saga_name}" saga? This ungroups its series — the series and books themselves aren't touched. This can't be undone.`))
      return
    setActionError(null)
    try {
      await deleteSaga(saga.saga_name)
      data.invalidate() // same reasoning as move() above
      navigate('/sagas')
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not reach the server')
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <Link to="/sagas" className="mb-4 inline-flex items-center gap-1 text-sm text-muted">
        <span aria-hidden="true">‹</span> Sagas
      </Link>

      {renaming ? (
        <div className="mb-4 flex gap-2">
          <input
            autoFocus
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            className="flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-primary"
          />
          <button onClick={() => void saveRename()} className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-slate-950">
            Save
          </button>
        </div>
      ) : (
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-primary">{saga.saga_name}</h1>
          <div className="flex gap-3 text-xs">
            <button onClick={() => setRenaming(true)} className="text-muted underline">
              Rename
            </button>
            <button onClick={() => void handleDelete()} className="text-red-400 underline">
              Delete
            </button>
          </div>
        </div>
      )}

      {actionError && <p className="mb-3 text-xs text-red-400">{actionError}</p>}

      {saga.series.length === 0 ? (
        <p className="mb-4 px-2 text-center text-sm text-subtle">No series yet — add the first one below.</p>
      ) : (
        <ul className="mb-4 divide-y divide-border rounded-lg border border-border">
          {saga.series.map((item, index) => {
            const info = seriesInfo.get(item.series_name)
            return (
              <li key={item.series_name} className="flex items-center gap-3 px-3 py-3">
                {/* Series Detail's own logic (dedupeCompanionPairs + a
                    comics-only arc sub-grouping that's a no-op for
                    audio/ebook series — see its own comment) already
                    works for any format, just not linked to from an
                    audio/ebook series anywhere else in the app yet. */}
                <Link
                  to={`/library/series/${encodeURIComponent(item.series_name)}`}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <div className="w-12 shrink-0">
                    <CoverArt title={item.series_name} coverUrl={info?.coverUrl} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-primary">{item.series_name}</p>
                    <p className="text-xs text-muted">
                      {info ? `${info.bookCount} book${info.bookCount === 1 ? '' : 's'}` : 'No books found for this series'}
                    </p>
                  </div>
                </Link>
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <button
                    onClick={() => void move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move up"
                    className="text-muted disabled:opacity-20"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => void move(index, 1)}
                    disabled={index === saga.series.length - 1}
                    aria-label="Move down"
                    className="text-muted disabled:opacity-20"
                  >
                    ▼
                  </button>
                </div>
                <button onClick={() => void removeSeries(item.series_name)} aria-label="Remove" className="shrink-0 text-red-400">
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <AddBooksToPlaylist books={sagaBooks} label={`the ${saga.saga_name} saga`} />

      {showPicker ? (
        <div className="rounded-lg border border-border-strong bg-surface p-3">
          <div className="mb-2 flex overflow-hidden rounded-lg border border-border-strong text-sm">
            {(
              [
                ['all', 'All'],
                ['books', 'Books'],
                ['comic', 'Comics'],
              ] as [ContentTypeFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setPickerContentType(value)}
                className={`flex-1 px-2 py-1.5 ${
                  pickerContentType === value ? 'bg-amber-400 text-slate-950' : 'bg-background text-secondary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            autoFocus
            type="text"
            placeholder="Search series…"
            value={pickerFilter}
            onChange={(e) => setPickerFilter(e.target.value)}
            className="mb-2 w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary placeholder:text-subtle"
          />
          {pickerCandidates.length === 0 ? (
            <p className="px-1 py-2 text-xs text-subtle">
              {pickerFilter ? 'No series match.' : 'Every series is already in this saga.'}
            </p>
          ) : (
            <ul className="mb-2 max-h-64 divide-y divide-border overflow-y-auto rounded border border-border">
              {pickerCandidates.map((name) => {
                const info = seriesInfo.get(name)
                const formats = seriesFormats.get(name)
                // Same glyphs as BookGrid's FormatBadge, so "is this the
                // audio series or the ebook one (or both)" reads at a
                // glance without opening it — merging audio+ebook into
                // one "Books" filter above means that distinction would
                // otherwise disappear entirely.
                const hasAudio = formats?.has('m4b') || formats?.has('mp3_folder')
                const hasEbook = formats?.has('epub')
                const hasComic = formats?.has('cbz')
                return (
                  <li key={name}>
                    <label className="flex items-center gap-2 px-3 py-2 text-sm text-primary">
                      <input
                        type="checkbox"
                        checked={pickerSelection.has(name)}
                        onChange={() => togglePickerSelection(name)}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="shrink-0 whitespace-nowrap text-xs">
                        {hasAudio && '🎧'}
                        {hasEbook && '📖'}
                        {hasComic && '💥'}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-xs text-subtle">
                        {info ? `${info.bookCount} book${info.bookCount === 1 ? '' : 's'}` : ''}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => void addSelectedSeries()}
              disabled={pickerSelection.size === 0 || adding}
              className="flex-1 rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-slate-950 disabled:opacity-40"
            >
              {adding ? 'Adding…' : `Add ${pickerSelection.size} series`}
            </button>
            <button
              onClick={() => {
                setShowPicker(false)
                setPickerSelection(new Set())
                setPickerFilter('')
              }}
              className="rounded-lg border border-border-strong px-3 py-2 text-sm text-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowPicker(true)}
          className="w-full rounded-lg border border-border-strong py-2 text-sm text-secondary"
        >
          + Add series…
        </button>
      )}
    </div>
  )
}
