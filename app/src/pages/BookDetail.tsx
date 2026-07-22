import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchBook } from '../api/client'
import { adaptBookDetail } from '../api/adapter'
import { reconcileProgress, removeFromContinueListening } from '../offline/reconcile'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { useDownloads } from '../hooks/useDownloads'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { usePlayer } from '../player/PlayerContext'
import { formatClock, formatDuration } from '../lib/format'
import {
  fetchPlaylists,
  addToPlaylist,
  findUpNext,
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
  const result = useAsync(async () => {
    const [book, progress] = await Promise.all([
      fetchBook(bookId!).then(adaptBookDetail),
      reconcileProgress(auth.token, bookId!),
    ])
    if (progress) {
      book.progress = { position: progress.position, chapterId: progress.chapterId || book.chapters[0].id }
    }
    return book
  }, [bookId])

  const downloads = useDownloads(bookId!, result.status === 'success' ? result.data.chapters : [])

  if (result.status === 'loading') {
    return <p className="px-4 pt-24 text-center text-muted">Loading…</p>
  }
  if (result.status === 'error') {
    return <LibraryError onRetry={result.retry} />
  }

  const book = result.data

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

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <div className="mx-auto w-40">
        <CoverArt title={book.title} coverUrl={book.coverFullUrl} />
      </div>
      <h1 className="mt-4 text-center text-xl font-semibold text-primary">{book.title}</h1>
      <p className="text-center text-sm text-muted">{book.author}</p>
      {book.seriesName && (
        <p className="text-center text-xs text-subtle">
          {book.seriesName} #{book.seriesNumber}
        </p>
      )}
      {book.sourceLabel && <p className="text-center text-xs text-subtle">{book.sourceLabel}</p>}
      {book.status === 'missing' && (
        <div className="mt-2 rounded bg-danger-soft px-3 py-2 text-center text-xs text-danger-soft-text">
          <p>This book's source file couldn't be found. Progress and bookmarks are kept.</p>
          <button onClick={() => navigate(`/book/${bookId}/relink`)} className="mt-2 underline">
            Relink
          </button>
        </div>
      )}

      <button
        onClick={playResume}
        disabled={book.status === 'missing' || book.chapters.length === 0}
        className="mt-4 w-full rounded-lg bg-amber-400 py-3 font-medium text-slate-950 disabled:opacity-40"
      >
        {hasProgress ? 'Resume' : 'Play'}
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
        <DownloadBadge book={book} downloads={downloads} />
      </div>

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
