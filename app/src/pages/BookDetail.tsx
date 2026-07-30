import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchBook, updateBook } from '../api/client'
import { adaptBookDetail } from '../api/adapter'
import { reconcileProgress, removeFromContinueListening } from '../offline/reconcile'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { useDownloads } from '../hooks/useDownloads'
import { useEbookDownload } from '../hooks/useEbookDownload'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { usePlayer } from '../player/PlayerContext'
import { formatClock, formatDuration } from '../lib/format'
import { companionLibraryIds, bookInLibrary } from '../library/companion'
import {
  fetchPlaylists,
  addToPlaylist,
  findUpNext,
  fetchMyLibrary,
  addToLibrary,
  removeFromLibrary,
  CloudApiError,
  type Playlist,
} from '../api/cloudClient'
import type { Book } from '../types'

function AddToPlaylist({ bookId }: { bookId: string }) {
  const auth = useAuth()
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function ensurePlaylistsLoaded(): Promise<Playlist[] | null> {
    if (playlists) return playlists
    if (!auth.token) return null
    try {
      const loaded = await fetchPlaylists(auth.token)
      setPlaylists(loaded)
      return loaded
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
      return null
    }
  }

  async function addTo(playlist: Playlist) {
    if (!auth.token) return
    setError(null)
    try {
      await addToPlaylist(auth.token, playlist.id, bookId)
      setFeedback(`Added to ${playlist.name}`)
      setShowPicker(false)
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
    }
  }

  async function handleAddToUpNext() {
    const loaded = await ensurePlaylistsLoaded()
    const upNext = loaded && findUpNext(loaded)
    if (upNext) void addTo(upNext)
  }

  async function togglePicker() {
    if (!showPicker) await ensurePlaylistsLoaded()
    setShowPicker((v) => !v)
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleAddToUpNext()}
          className="flex-1 rounded-lg border border-border-strong py-2 text-sm text-primary"
        >
          + Add to Up Next
        </button>
        <button onClick={() => void togglePicker()} className="text-sm text-amber-400 underline">
          Add to a playlist…
        </button>
      </div>

      {showPicker && playlists && (
        <div className="mt-2 rounded-lg border border-border-strong bg-surface p-2 shadow-lg">
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => void addTo(p)}
              className="block w-full rounded px-3 py-2 text-left text-sm text-primary hover:bg-border"
            >
              {p.is_reserved ? '▶️ ' : ''}
              {p.name}
            </button>
          ))}
        </div>
      )}

      {feedback && <p className="mt-1 text-center text-xs text-emerald-400">{feedback}</p>}
      {error && <p className="mt-1 text-center text-xs text-red-400">{error}</p>}
    </div>
  )
}

function DownloadBadge({
  book,
  downloads,
}: {
  book: Book
  downloads: ReturnType<typeof useDownloads>
}) {
  const cachedCount = book.chapters.filter((c) => downloads.isCached(c)).length
  if (cachedCount === 0) {
    return (
      <button
        onClick={() => void downloads.downloadAll()}
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary"
      >
        Download whole book
      </button>
    )
  }
  if (cachedCount === book.chapters.length) {
    return (
      <button
        onClick={() => void downloads.removeAll()}
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-amber-400"
      >
        Downloaded — remove
      </button>
    )
  }
  return (
    <button
      onClick={() => void downloads.downloadAll()}
      className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary"
    >
      {cachedCount}/{book.chapters.length} downloaded — finish
    </button>
  )
}

// A single file, not N chapters sharing M source files like audio — no
// partial-progress state, just cached or not.
function EbookDownloadBadge({ download }: { download: ReturnType<typeof useEbookDownload> }) {
  if (download.cached) {
    return (
      <button
        onClick={() => void download.remove()}
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-amber-400"
      >
        Ebook downloaded — remove
      </button>
    )
  }
  return (
    <button
      onClick={() => void download.download()}
      disabled={download.pending}
      className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary disabled:opacity-40"
    >
      {download.pending ? 'Downloading…' : 'Download ebook'}
    </button>
  )
}

export function BookDetail() {
  const { bookId } = useParams()
  const navigate = useNavigate()
  const player = usePlayer()
  const auth = useAuth()
  // `book.progress` is set by mutating the fetched object in-place below
  // (see the useAsync fetcher), so it won't trigger a re-render on its own
  // when cleared — this local flag is what actually drives the UI after a
  // removal, independent of that object identity.
  const [progressCleared, setProgressCleared] = useState(false)
  const [editingSeries, setEditingSeries] = useState(false)
  const [seriesNameDraft, setSeriesNameDraft] = useState('')
  const [seriesNumberDraft, setSeriesNumberDraft] = useState('')
  const [seriesError, setSeriesError] = useState<string | null>(null)
  // Overrides the fetched shelf-membership check the instant Add/Remove is
  // tapped — same optimistic-then-reconcile shape as progressCleared
  // above, rather than waiting on (or forcing) a full re-fetch.
  const [libraryOverride, setLibraryOverride] = useState<boolean | null>(null)
  const result = useAsync(async () => {
    const [book, progress, libraryItems] = await Promise.all([
      fetchBook(bookId!).then(adaptBookDetail),
      reconcileProgress(auth.token, bookId!),
      auth.token ? fetchMyLibrary(auth.token) : Promise.resolve([]),
    ])
    if (progress) {
      // book.chapters[0] doesn't exist for an epub-only book (ebook
      // reading position is CFI-based, not chapter-based, so its saved
      // progress rows never have a real chapterId to begin with) — fall
      // back to '' instead of crashing on chapters[0].id for that case.
      book.progress = { position: progress.position, chapterId: progress.chapterId || book.chapters[0]?.id || '' }
    }
    const fetchedLibraryIds = new Set(libraryItems.map((i) => i.book_id))
    const isInMyLibrary = bookInLibrary(book, fetchedLibraryIds)
    return { book, isInMyLibrary }
  }, [bookId])

  const downloads = useDownloads(bookId!, result.status === 'success' ? result.data.book.chapters : [])
  const epubIdForDownload =
    result.status === 'success'
      ? result.data.book.format === 'epub'
        ? result.data.book.id
        : result.data.book.companionBookId
      : undefined
  const ebookDownload = useEbookDownload(epubIdForDownload)

  if (result.status === 'loading') {
    return <p className="px-4 pt-24 text-center text-muted">Loading…</p>
  }
  if (result.status === 'error') {
    return <LibraryError onRetry={result.retry} error={result.error} />
  }

  const book = result.data.book
  // The override, if set, always wins — it reflects the most recent
  // Add/Remove tap, which may not have made it into a re-fetch yet.
  const isInMyLibrary = libraryOverride ?? result.data.isInMyLibrary

  async function handleToggleLibrary() {
    if (!auth.token) return
    const next = !isInMyLibrary
    setLibraryOverride(next)
    try {
      const ids = companionLibraryIds(book)
      await Promise.all(ids.map((id) => (next ? addToLibrary(auth.token!, id) : removeFromLibrary(auth.token!, id))))
    } catch {
      setLibraryOverride(!next)
    }
  }

  // Every chapter shares the same underlying file for a single m4b with
  // embedded chapter markers (as opposed to an mp3-folder book, or a
  // multi-part m4b, where each chapter really is its own file) — per-chapter
  // download doesn't mean anything distinct in that case, since downloading
  // any one chapter already downloads the whole book. Showing a download
  // button on every one of what can be dozens of chapter markers is just
  // confusing; the "Download whole book" badge above already covers it.
  const singleFile =
    book.chapters.length > 0 && book.chapters.every((c) => c.sourceFileId === book.chapters[0].sourceFileId)

  function playFrom(chapterId: string, resumeAt = 0) {
    player.loadBook(book, chapterId, resumeAt)
    player.play()
    navigate('/now-playing')
  }

  const hasProgress = !!book.progress && !progressCleared

  function playResume() {
    if (hasProgress && book.progress && book.progress.position.type === 'timestamp') {
      playFrom(book.progress.chapterId, book.progress.position.value)
    } else {
      playFrom(book.chapters[0].id)
    }
  }

  async function handleRemoveFromContinueListening() {
    setProgressCleared(true)
    try {
      await removeFromContinueListening(auth.token, book.id)
    } catch {
      setProgressCleared(false)
    }
  }

  function startEditingSeries() {
    setSeriesError(null)
    setSeriesNameDraft(book.seriesName ?? '')
    setSeriesNumberDraft(book.seriesNumber !== undefined ? String(book.seriesNumber) : '')
    setEditingSeries(true)
  }

  async function saveSeries() {
    setSeriesError(null)
    const trimmedName = seriesNameDraft.trim()
    const parsedNumber = seriesNumberDraft.trim() === '' ? null : Number(seriesNumberDraft)
    if (parsedNumber !== null && Number.isNaN(parsedNumber)) {
      setSeriesError('Series number must be a number')
      return
    }
    try {
      await updateBook(book.id, { seriesName: trimmedName === '' ? null : trimmedName, seriesNumber: parsedNumber })
      // Mutated in place, same as book.progress above — book is the
      // useAsync-cached object for this bookId, not re-fetched on every
      // render, so this is what makes the edit show up immediately.
      book.seriesName = trimmedName === '' ? undefined : trimmedName
      book.seriesNumber = parsedNumber ?? undefined
      setEditingSeries(false)
    } catch (err) {
      setSeriesError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <div className="mx-auto w-40">
        <CoverArt title={book.title} coverUrl={book.coverFullUrl} />
      </div>
      <h1 className="mt-4 text-center text-xl font-semibold text-primary">{book.title}</h1>
      <p className="text-center text-sm text-muted">{book.author}</p>
      {editingSeries ? (
        <div className="mt-2 flex items-center justify-center gap-2">
          <input
            type="text"
            value={seriesNameDraft}
            onChange={(e) => setSeriesNameDraft(e.target.value)}
            placeholder="Series name"
            className="w-32 rounded border border-border-strong bg-surface px-2 py-1 text-center text-xs text-primary placeholder:text-subtle"
          />
          <input
            type="number"
            value={seriesNumberDraft}
            onChange={(e) => setSeriesNumberDraft(e.target.value)}
            placeholder="#"
            className="w-14 rounded border border-border-strong bg-surface px-2 py-1 text-center text-xs text-primary placeholder:text-subtle"
          />
          <button onClick={() => void saveSeries()} className="text-xs text-amber-400 underline">
            Save
          </button>
          <button onClick={() => setEditingSeries(false)} className="text-xs text-subtle underline">
            Cancel
          </button>
        </div>
      ) : (
        <p className="mt-1 text-center text-xs text-subtle">
          {book.seriesName && (
            <>
              {book.seriesName}
              {book.seriesNumber !== undefined && ` #${book.seriesNumber}`}
              {' · '}
            </>
          )}
          <button onClick={startEditingSeries} className="underline">
            {book.seriesName ? 'Edit' : '+ Add series info'}
          </button>
        </p>
      )}
      {seriesError && <p className="mt-1 text-center text-xs text-red-400">{seriesError}</p>}
      {book.sourceLabel && <p className="text-center text-xs text-subtle">{book.sourceLabel}</p>}
      {book.status === 'missing' && (
        <div className="mt-2 rounded bg-danger-soft px-3 py-2 text-center text-xs text-danger-soft-text">
          <p>This book's source file couldn't be found. Progress and bookmarks are kept.</p>
          {isInMyLibrary && (
            <p className="mt-1">
              It'll be cleaned up by the library's normal missing-book housekeeping if nobody relinks it.
            </p>
          )}
          <div className="mt-2 flex items-center justify-center gap-3">
            <button onClick={() => navigate(`/book/${bookId}/relink`)} className="underline">
              Relink
            </button>
            {isInMyLibrary && (
              <button onClick={() => void handleToggleLibrary()} className="underline">
                Remove from My Library
              </button>
            )}
          </div>
        </div>
      )}

      {book.companionBookId ? (
        // A companion pair — equal-weight side by side, so neither format
        // reads as the "real" book and the other as an afterthought.
        <div className="mt-4 flex gap-2">
          {book.format === 'epub' ? (
            <>
              <button
                onClick={() => navigate(`/book/${book.id}/read`)}
                className="flex-1 rounded-lg bg-amber-400 py-3 font-medium text-slate-950"
              >
                📖 Read
              </button>
              <button
                onClick={() => navigate(`/book/${book.companionBookId}`)}
                className="flex-1 rounded-lg bg-amber-400 py-3 font-medium text-slate-950"
              >
                🎧 Listen
              </button>
            </>
          ) : (
            <>
              <button
                onClick={playResume}
                disabled={book.status === 'missing' || book.chapters.length === 0}
                className="flex-1 rounded-lg bg-amber-400 py-3 font-medium text-slate-950 disabled:opacity-40"
              >
                🎧 {hasProgress ? 'Resume' : 'Play'}
              </button>
              <button
                onClick={() => navigate(`/book/${book.companionBookId}/read`)}
                className="flex-1 rounded-lg bg-amber-400 py-3 font-medium text-slate-950"
              >
                📖 Read
              </button>
            </>
          )}
        </div>
      ) : book.format === 'epub' ? (
        <button
          onClick={() => navigate(`/book/${book.id}/read`)}
          className="mt-4 w-full rounded-lg bg-amber-400 py-3 font-medium text-slate-950"
        >
          Read
        </button>
      ) : (
        <button
          onClick={playResume}
          disabled={book.status === 'missing' || book.chapters.length === 0}
          className="mt-4 w-full rounded-lg bg-amber-400 py-3 font-medium text-slate-950 disabled:opacity-40"
        >
          {hasProgress ? 'Resume' : 'Play'}
        </button>
      )}

      <button
        onClick={() => void handleToggleLibrary()}
        className="mt-2 w-full rounded-lg border border-border-strong py-2 text-sm text-secondary"
      >
        {isInMyLibrary ? '✓ On My Library' : '+ Add to My Library'}
      </button>

      {hasProgress && (
        <button
          onClick={() => void handleRemoveFromContinueListening()}
          className="mt-1 w-full text-center text-xs text-subtle underline"
        >
          Remove from Continue Listening
        </button>
      )}

      <AddToPlaylist bookId={book.id} />

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-subtle">{formatDuration(book.totalDuration)} total</p>
        <div className="flex items-center gap-2">
          {book.format !== 'epub' && <DownloadBadge book={book} downloads={downloads} />}
          {epubIdForDownload && <EbookDownloadBadge download={ebookDownload} />}
        </div>
      </div>

      {book.synopsis && (
        <div className="mt-6">
          <p className="text-sm font-medium text-primary">Synopsis</p>
          <p className="mt-2 whitespace-pre-line text-sm text-muted">{book.synopsis}</p>
        </div>
      )}

      <ul className="mt-6 divide-y divide-border">
        {book.chapters.map((chapter) => (
          <li key={chapter.id} className="flex items-center justify-between py-3">
            <button
              onClick={() => playFrom(chapter.id)}
              disabled={book.status === 'missing'}
              className="flex-1 text-left disabled:opacity-40"
            >
              {/* A chapter's embedded title can look exactly like a
                  standalone filename (e.g. merged multi-part rips that
                  kept each original part's name as its chapter title,
                  "Book 10 - Small Favor #01") — easy to mistake for a
                  separate file rather than a chapter of this book.
                  Always showing the chapter's own number first makes it
                  read as "chapter N" no matter what the embedded title
                  says. */}
              <span className="text-sm text-primary">
                <span className="text-subtle">{chapter.index + 1}.</span> {chapter.title}
              </span>
            </button>
            <span className="text-xs text-subtle">{formatClock(chapter.duration)}</span>
            {!singleFile && (
              <button
                onClick={() =>
                  void (downloads.isCached(chapter) ? downloads.remove(chapter) : downloads.download(chapter))
                }
                disabled={downloads.isPending(chapter)}
                aria-label={downloads.isCached(chapter) ? 'Remove download' : 'Download chapter'}
                className="ml-3 text-lg text-muted disabled:opacity-40"
              >
                {downloads.isPending(chapter) ? '⏳' : downloads.isCached(chapter) ? '✓' : '⬇'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
