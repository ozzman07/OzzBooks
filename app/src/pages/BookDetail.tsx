import { useNavigate, useParams } from 'react-router-dom'
import { fetchBook } from '../api/client'
import { adaptBookDetail } from '../api/adapter'
import { reconcileProgress } from '../offline/reconcile'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { useDownloads } from '../hooks/useDownloads'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { usePlayer } from '../player/PlayerContext'
import { formatClock, formatDuration } from '../lib/format'
import type { Book } from '../types'

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
        className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300"
      >
        Download whole book
      </button>
    )
  }
  if (cachedCount === book.chapters.length) {
    return (
      <button
        onClick={() => void downloads.removeAll()}
        className="rounded border border-slate-700 px-3 py-1.5 text-xs text-amber-400"
      >
        Downloaded — remove
      </button>
    )
  }
  return (
    <button
      onClick={() => void downloads.downloadAll()}
      className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300"
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
    return <p className="px-4 pt-24 text-center text-slate-400">Loading…</p>
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

  function playResume() {
    if (book.progress && book.progress.position.type === 'timestamp') {
      playFrom(book.progress.chapterId, book.progress.position.value)
    } else {
      playFrom(book.chapters[0].id)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <div className="mx-auto w-40">
        <CoverArt title={book.title} coverUrl={book.coverFullUrl} />
      </div>
      <h1 className="mt-4 text-center text-xl font-semibold text-slate-50">{book.title}</h1>
      <p className="text-center text-sm text-slate-400">{book.author}</p>
      {book.seriesName && (
        <p className="text-center text-xs text-slate-500">
          {book.seriesName} #{book.seriesNumber}
        </p>
      )}
      {book.status === 'missing' && (
        <div className="mt-2 rounded bg-red-900/40 px-3 py-2 text-center text-xs text-red-300">
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
        {book.progress ? 'Resume' : 'Play'}
      </button>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-slate-500">{formatDuration(book.totalDuration)} total</p>
        <DownloadBadge book={book} downloads={downloads} />
      </div>

      <ul className="mt-6 divide-y divide-slate-800">
        {book.chapters.map((chapter) => (
          <li key={chapter.id} className="flex items-center justify-between py-3">
            <button
              onClick={() => playFrom(chapter.id)}
              disabled={book.status === 'missing'}
              className="flex-1 text-left disabled:opacity-40"
            >
              <span className="text-sm text-slate-200">{chapter.title}</span>
            </button>
            <span className="text-xs text-slate-500">{formatClock(chapter.duration)}</span>
            {!singleFile && (
              <button
                onClick={() =>
                  void (downloads.isCached(chapter) ? downloads.remove(chapter) : downloads.download(chapter))
                }
                disabled={downloads.isPending(chapter)}
                aria-label={downloads.isCached(chapter) ? 'Remove download' : 'Download chapter'}
                className="ml-3 text-lg text-slate-400 disabled:opacity-40"
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
