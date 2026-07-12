import { useNavigate, useParams } from 'react-router-dom'
import { fetchBook } from '../api/client'
import { adaptBookDetail } from '../api/adapter'
import { fetchBookProgress } from '../api/cloudClient'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { usePlayer } from '../player/PlayerContext'
import { formatClock, formatDuration } from '../lib/format'

export function BookDetail() {
  const { bookId } = useParams()
  const navigate = useNavigate()
  const player = usePlayer()
  const auth = useAuth()
  const result = useAsync(async () => {
    const [book, progress] = await Promise.all([
      fetchBook(bookId!).then(adaptBookDetail),
      auth.token ? fetchBookProgress(auth.token, bookId!) : Promise.resolve(null),
    ])
    if (progress) {
      book.progress = { position: progress.position, chapterId: progress.chapter_id ?? book.chapters[0].id }
    }
    return book
  }, [bookId])

  if (result.status === 'loading') {
    return <p className="px-4 pt-24 text-center text-slate-400">Loading…</p>
  }
  if (result.status === 'error') {
    return <LibraryError onRetry={result.retry} />
  }

  const book = result.data

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
        <p className="mt-2 rounded bg-red-900/40 px-3 py-2 text-center text-xs text-red-300">
          This book's source file couldn't be found. Progress and bookmarks are kept — relink it
          from Settings to resume playback.
        </p>
      )}

      <button
        onClick={playResume}
        disabled={book.status === 'missing' || book.chapters.length === 0}
        className="mt-4 w-full rounded-lg bg-amber-400 py-3 font-medium text-slate-950 disabled:opacity-40"
      >
        {book.progress ? 'Resume' : 'Play'}
      </button>

      <p className="mt-3 text-xs text-slate-500">{formatDuration(book.totalDuration)} total</p>

      <ul className="mt-6 divide-y divide-slate-800">
        {book.chapters.map((chapter) => (
          <li key={chapter.id}>
            <button
              onClick={() => playFrom(chapter.id)}
              disabled={book.status === 'missing'}
              className="flex w-full items-center justify-between py-3 text-left disabled:opacity-40"
            >
              <span className="text-sm text-slate-200">{chapter.title}</span>
              <span className="text-xs text-slate-500">{formatClock(chapter.duration)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
