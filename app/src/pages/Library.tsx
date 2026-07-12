import { Link } from 'react-router-dom'
import { fetchBooks } from '../api/client'
import { adaptBookListItem } from '../api/adapter'
import { useAsync } from '../hooks/useAsync'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { formatDuration } from '../lib/format'

export function Library() {
  const result = useAsync(async () => (await fetchBooks()).map(adaptBookListItem), [])

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-slate-50">Your Library</h1>

      {result.status === 'loading' && <p className="text-center text-slate-400">Loading your library…</p>}

      {result.status === 'error' && <LibraryError onRetry={result.retry} />}

      {result.status === 'success' && result.data.length === 0 && (
        <p className="px-2 text-center text-slate-400">
          No books yet — add a source and scan it to start building your library.
        </p>
      )}

      {result.status === 'success' && result.data.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-400">All Books</h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {result.data.map((book) => (
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
      )}
    </div>
  )
}
