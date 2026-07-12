import { Link } from 'react-router-dom'
import { fetchBooks } from '../api/client'
import { adaptBookListItem } from '../api/adapter'
import { fetchAllProgress } from '../api/cloudClient'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { formatDuration } from '../lib/format'
import type { Book } from '../types'

export function Library() {
  const auth = useAuth()
  const result = useAsync(async () => {
    const [books, progressEntries] = await Promise.all([
      fetchBooks().then((rows) => rows.map(adaptBookListItem)),
      auth.token ? fetchAllProgress(auth.token) : Promise.resolve([]),
    ])

    const byBookId = new Map(books.map((b) => [b.id, b]))
    const continueListening = progressEntries
      .slice()
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((p) => byBookId.get(p.book_id))
      .filter((b): b is Book => b !== undefined)

    return { books, continueListening }
  }, [])

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-slate-50">Your Library</h1>

      {result.status === 'loading' && <p className="text-center text-slate-400">Loading your library…</p>}

      {result.status === 'error' && <LibraryError onRetry={result.retry} />}

      {result.status === 'success' && result.data.books.length === 0 && (
        <p className="px-2 text-center text-slate-400">
          No books yet — add a source and scan it to start building your library.
        </p>
      )}

      {result.status === 'success' && result.data.continueListening.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-400">
            Continue Listening
          </h2>
          <ul className="flex gap-3 overflow-x-auto pb-1">
            {result.data.continueListening.map((book) => (
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

      {result.status === 'success' && result.data.books.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-400">All Books</h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {result.data.books.map((book) => (
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
