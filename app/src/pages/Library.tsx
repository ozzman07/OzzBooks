import { Link } from 'react-router-dom'
import { mockBooks } from '../data/mockBooks'
import { CoverArt } from '../components/CoverArt'
import { formatDuration } from '../lib/format'

export function Library() {
  const continueListening = mockBooks.filter((b) => b.progress)

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-slate-50">Your Library</h1>

      {continueListening.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-400">
            Continue Listening
          </h2>
          <ul className="flex gap-3 overflow-x-auto pb-1">
            {continueListening.map((book) => (
              <li key={book.id} className="w-28 shrink-0">
                <Link to={`/book/${book.id}`}>
                  <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
                  <p className="mt-1 truncate text-xs text-slate-300">{book.title}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-400">
          All Books
        </h2>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {mockBooks.map((book) => (
            <li key={book.id}>
              <Link to={`/book/${book.id}`} className="block">
                <div className="relative">
                  <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
                  {book.status === 'missing' && (
                    <span className="absolute right-1 top-1 rounded bg-red-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      Needs attention
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-sm text-slate-100">{book.title}</p>
                <p className="truncate text-xs text-slate-400">{book.author}</p>
                <p className="text-xs text-slate-500">{formatDuration(book.totalDuration)}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
