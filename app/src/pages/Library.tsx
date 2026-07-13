import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchBooks } from '../api/client'
import { adaptBookListItem } from '../api/adapter'
import { reconcileAllProgress } from '../offline/reconcile'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { formatDuration } from '../lib/format'
import type { Book } from '../types'

type SortOption = 'title' | 'author' | 'series' | 'recent'
type ViewMode = 'list' | 'byAuthor'

const SORT_LABELS: Record<SortOption, string> = {
  title: 'Title (A–Z)',
  author: 'Author (A–Z)',
  series: 'Series',
  recent: 'Recently added',
}

function collate(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

// Author tags in this library are a mix of "First Last" (the common case)
// and already-inverted "Last, First" (e.g. "Clarke, Arthur C.") — plus some
// multi-author/role-annotated strings ("Eric Flint, Andrew Dennis",
// "Arthur Conan Doyle, Stephen Fry - introductions"). The two single-author
// formats are reliably told apart by word count before the first comma:
// "Last, First" always has exactly one word there ("Clarke"), while
// multi-author strings have two or more ("Eric Flint"). Falls back to the
// last word of that segment either way, which also handles plain
// "First Last" (no comma at all).
//
// Known limitation: a tag with the narrator listed first, e.g.
// "Will Patton, Stephen King" (Patton narrates, King wrote it), sorts under
// "Patton" — there's no reliable way to tell narrator-first from
// author-first in a plain string tag. Display is never affected, only sort
// order.
function authorSortKey(author: string): string {
  const [firstSegment] = author.split(',')
  const words = firstSegment.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return author
  const isAlreadyLastFirst = words.length === 1 && author.includes(',')
  return isAlreadyLastFirst ? words[0] : words[words.length - 1]
}

function collateByAuthor(a: string, b: string): number {
  return collate(authorSortKey(a), authorSortKey(b)) || collate(a, b)
}

interface AuthorGroup {
  author: string
  books: Book[]
}

function groupByAuthor(books: Book[]): AuthorGroup[] {
  const byAuthor = new Map<string, Book[]>()
  for (const book of books) {
    const list = byAuthor.get(book.author) ?? []
    list.push(book)
    byAuthor.set(book.author, list)
  }
  return [...byAuthor.entries()]
    .map(([author, group]) => ({ author, books: group.slice().sort((a, b) => collate(a.title, b.title)) }))
    .sort((a, b) => collateByAuthor(a.author, b.author))
}

function BookTile({ book }: { book: Book }) {
  return (
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
  )
}

function sortBooks(books: Book[], sortBy: SortOption): Book[] {
  return books.slice().sort((a, b) => {
    switch (sortBy) {
      case 'author':
        return collateByAuthor(a.author, b.author) || collate(a.title, b.title)
      case 'series': {
        // Books outside a series sort by their own title, alongside
        // series names, so everything still lands in one coherent list
        // rather than being split into separate "grouped"/"ungrouped" runs.
        const seriesCompare = collate(a.seriesName ?? a.title, b.seriesName ?? b.title)
        if (seriesCompare !== 0) return seriesCompare
        return (a.seriesNumber ?? 0) - (b.seriesNumber ?? 0) || collate(a.title, b.title)
      }
      case 'recent':
        return b.createdAt.localeCompare(a.createdAt)
      case 'title':
      default:
        return collate(a.title, b.title)
    }
  })
}

export function Library() {
  const auth = useAuth()
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('title')
  const [viewMode, setViewMode] = useState<ViewMode>('list')

  const result = useAsync(async () => {
    const [books, progressEntries] = await Promise.all([
      fetchBooks().then((rows) => rows.map(adaptBookListItem)),
      reconcileAllProgress(auth.token),
    ])

    const byBookId = new Map(books.map((b) => [b.id, b]))
    const continueListening = progressEntries
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => byBookId.get(p.bookId))
      .filter((b): b is Book => b !== undefined)

    return { books, continueListening }
  }, [])

  const filteredBooks = useMemo(() => {
    if (result.status !== 'success') return []
    const query = search.trim().toLowerCase()
    return query
      ? result.data.books.filter(
          (b) => b.title.toLowerCase().includes(query) || b.author.toLowerCase().includes(query),
        )
      : result.data.books
  }, [result, search])

  const visibleBooks = useMemo(() => sortBooks(filteredBooks, sortBy), [filteredBooks, sortBy])

  // Author browse fixes its own ordering (group by author, title within
  // group) rather than the sort dropdown — grouping already establishes an
  // order across authors, so the dropdown's options don't map cleanly onto
  // "what order do groups/books appear in" the way they do for the flat list.
  const authorGroups = useMemo(() => groupByAuthor(filteredBooks), [filteredBooks])

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6">
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
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-medium uppercase tracking-wide text-slate-400">
              All Books · {filteredBooks.length}
            </h2>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or author"
              className="w-full flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 sm:w-auto"
            />
            <div className="flex overflow-hidden rounded-lg border border-slate-700 text-sm">
              <button
                onClick={() => setViewMode('list')}
                className={`px-3 py-1.5 ${viewMode === 'list' ? 'bg-amber-400 text-slate-950' : 'bg-slate-900 text-slate-300'}`}
              >
                List
              </button>
              <button
                onClick={() => setViewMode('byAuthor')}
                className={`px-3 py-1.5 ${viewMode === 'byAuthor' ? 'bg-amber-400 text-slate-950' : 'bg-slate-900 text-slate-300'}`}
              >
                By Author
              </button>
            </div>
            {viewMode === 'list' && (
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
              >
                {(Object.entries(SORT_LABELS) as [SortOption, string][]).map(([value, label]) => (
                  <option key={value} value={value}>
                    Sort: {label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {filteredBooks.length === 0 ? (
            <p className="px-2 text-center text-slate-400">No books match "{search}".</p>
          ) : viewMode === 'list' ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
              {visibleBooks.map((book) => (
                <li key={book.id}>
                  <BookTile book={book} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-6">
              {authorGroups.map((group) => (
                <div key={group.author}>
                  <h3 className="mb-2 text-sm font-medium text-slate-300">
                    {group.author} · {group.books.length}
                  </h3>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
                    {group.books.map((book) => (
                      <li key={book.id}>
                        <BookTile book={book} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
