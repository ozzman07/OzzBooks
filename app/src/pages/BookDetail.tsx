import { useNavigate, useParams } from 'react-router-dom'
import { mockBooks } from '../data/mockBooks'
import { CoverArt } from '../components/CoverArt'
import { usePlayer } from '../player/PlayerContext'
import { formatClock, formatDuration } from '../lib/format'

export function BookDetail() {
  const { bookId } = useParams()
  const navigate = useNavigate()
  const player = usePlayer()
  const book = mockBooks.find((b) => b.id === bookId)

  if (!book) {
    return <div className="px-4 pt-8 text-center text-slate-400">Book not found.</div>
  }

  function playFrom(chapterId: string) {
    if (!book) return
    player.loadBook(book, chapterId)
    player.play()
    navigate('/now-playing')
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
        onClick={() => playFrom(book.progress?.chapterId ?? book.chapters[0].id)}
        disabled={book.status === 'missing'}
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
