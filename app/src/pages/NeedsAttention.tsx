import { useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchBooks, removeMissingBook } from '../api/client'
import { adaptBookListItem } from '../api/adapter'
import { useAsync } from '../hooks/useAsync'
import { CoverArt } from '../components/CoverArt'

export function NeedsAttention() {
  const result = useAsync(() => fetchBooks('missing').then((rows) => rows.map(adaptBookListItem)), [])
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [removingId, setRemovingId] = useState<string | null>(null)

  async function handleRemove(bookId: string) {
    setRemovingId(bookId)
    try {
      await removeMissingBook(bookId)
      setRemovedIds((prev) => new Set(prev).add(bookId))
    } catch {
      // Left in the list — the button is still there to retry.
    } finally {
      setRemovingId(null)
    }
  }

  const books = result.status === 'success' ? result.data.filter((b) => !removedIds.has(b.id)) : []

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-primary">Needs Attention</h1>
        <Link to="/settings" className="text-xs text-muted">
          ← Settings
        </Link>
      </div>

      <p className="mb-4 text-xs text-subtle">
        These books' source files couldn't be found on their last scan. Progress and bookmarks are kept — relink a
        book to reconnect it, or remove it to clear it from this list.
      </p>

      {result.status === 'loading' && <p className="text-center text-muted">Loading…</p>}

      {result.status === 'error' && (
        <div className="flex flex-col items-center gap-3 pt-12 text-center text-muted">
          <p className="text-sm">Couldn't load the list.</p>
          <button onClick={result.retry} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950">
            Retry
          </button>
        </div>
      )}

      {result.status === 'success' && books.length === 0 && (
        <p className="pt-12 text-center text-sm text-subtle">Nothing needs attention right now.</p>
      )}

      {result.status === 'success' && books.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {books.map((book) => (
            <li key={book.id} className="flex items-center gap-3 px-4 py-3">
              <Link to={`/book/${book.id}`} className="w-12 shrink-0">
                <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
              </Link>
              <Link to={`/book/${book.id}`} className="min-w-0 flex-1">
                <p className="truncate text-sm text-primary">{book.title}</p>
                <p className="truncate text-xs text-muted">{book.author}</p>
              </Link>
              <button
                onClick={() => void handleRemove(book.id)}
                disabled={removingId === book.id}
                className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-secondary disabled:opacity-40"
              >
                {removingId === book.id ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
