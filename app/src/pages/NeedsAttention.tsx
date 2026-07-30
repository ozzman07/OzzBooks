import { useState } from 'react'
import { Link } from 'react-router-dom'
import { removeMissingBook } from '../api/client'
import { useAppData } from '../data/AppDataContext'
import { bookInLibrary } from '../library/companion'
import { CoverArt } from '../components/CoverArt'
import { useLibraryView, type NeedsAttentionScope } from '../library/LibraryViewContext'

const SCOPE_LABELS: Record<NeedsAttentionScope, string> = {
  mine: 'My Library',
  everyone: 'Everyone',
}

export function NeedsAttention() {
  const data = useAppData()
  const { needsAttentionScope, setNeedsAttentionScope } = useLibraryView()
  const [removingId, setRemovingId] = useState<string | null>(null)

  async function handleRemove(bookId: string) {
    setRemovingId(bookId)
    try {
      await removeMissingBook(bookId)
      data.removeCachedBook(bookId)
    } catch {
      // Left in the list — the button is still there to retry.
    } finally {
      setRemovingId(null)
    }
  }

  // Scoped to "my shelf" by default for the same reason the main Library
  // grid is: as more people add their own sources, an unfiltered missing-
  // books list gets just as cluttered as the old unfiltered main grid did.
  const books = data.books
    .filter((b) => b.status === 'missing')
    .filter((b) => needsAttentionScope === 'everyone' || bookInLibrary(b, data.myLibraryIds))

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-primary">Needs Attention</h1>
        <Link to="/settings" className="text-xs text-muted">
          ← Settings
        </Link>
      </div>

      <p className="mb-3 text-xs text-subtle">
        These books' source files couldn't be found on their last scan. Progress and bookmarks are kept — relink a
        book to reconnect it, or remove it to clear it from this list.
      </p>

      <div className="mb-4 flex overflow-hidden rounded-lg border border-border-strong text-xs">
        {(Object.entries(SCOPE_LABELS) as [NeedsAttentionScope, string][]).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setNeedsAttentionScope(value)}
            className={`px-2.5 py-1.5 ${needsAttentionScope === value ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {data.status === 'loading' && <p className="text-center text-muted">Loading…</p>}

      {data.status === 'error' && (
        <div className="flex flex-col items-center gap-3 pt-12 text-center text-muted">
          <p className="text-sm">Couldn't load the list.</p>
          <button onClick={() => void data.refresh()} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950">
            Retry
          </button>
        </div>
      )}

      {data.status === 'success' && books.length === 0 && (
        <p className="pt-12 text-center text-sm text-subtle">
          {needsAttentionScope === 'mine'
            ? 'Nothing on your shelf needs attention right now.'
            : 'Nothing needs attention right now.'}
        </p>
      )}

      {data.status === 'success' && books.length > 0 && (
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
