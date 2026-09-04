import { Link } from 'react-router-dom'
import { CoverArt } from './CoverArt'
import { formatDuration } from '../lib/format'
import { bookInLibrary } from '../library/companion'
import { isAudioFormat, isComicFormat } from '../library/bookOrganize'
import type { Book } from '../types'
import type { DisplayMode } from '../library/LibraryViewContext'

// Shown on every tile/row, not just the ebook-capable exceptions, per the
// user's explicit ask — a badge that only appears sometimes reads as an
// error state at a glance; always showing one makes "what can I do with
// this book" consistent to scan across a mixed audio/ebook library. Comics
// get their own glyph (💥) — a comics-specific badge parallel to the
// existing 🎧/📖, per Ozzbooks_Addendum_Comics.
export function FormatBadge({ book, className = '' }: { book: Book; className?: string }) {
  if (isComicFormat(book)) {
    return (
      <span className={`whitespace-nowrap ${className}`} title="Comic">
        💥
      </span>
    )
  }
  const hasAudio = isAudioFormat(book)
  const hasEbook = book.format === 'epub' || Boolean(book.companionBookId)
  return (
    <span className={`whitespace-nowrap ${className}`} title={hasAudio && hasEbook ? 'Audiobook + ebook' : hasAudio ? 'Audiobook' : 'Ebook'}>
      {hasAudio && '🎧'}
      {hasEbook && '📖'}
    </span>
  )
}

// The tile/row subtitle line — author for audio/ebooks, but a comic has no
// author concept (Writer/Artist are separate fields shown on Book Detail,
// not stored on books.author — see Ozzbooks_Addendum_Comics). Shows issue
// number + series instead, the more useful "which one is this" signal for
// a comics library that's mostly collected graphic novels grouped by
// franchise folder.
function BookSubtitle({ book }: { book: Book }) {
  if (isComicFormat(book)) {
    if (!book.seriesName) return null
    return (
      <>
        {book.seriesName}
        {book.seriesNumber !== undefined && ` #${book.seriesNumber}`}
      </>
    )
  }
  return <>{book.author}</>
}

// Only rendered in Store mode (see BookGrid) — lets someone shelve a book
// straight from the grid without drilling into BookDetail first. Sits
// outside the tile/row's own <Link> (same pattern as the existing
// In Progress ✕ button) so tapping it doesn't also navigate.
function LibraryToggleButton({
  inMyLibrary,
  onToggle,
  className,
}: {
  inMyLibrary: boolean
  onToggle: (e: React.MouseEvent) => void
  className: string
}) {
  return (
    <button
      onClick={onToggle}
      aria-label={inMyLibrary ? 'Remove from My Library' : 'Add to My Library'}
      title={inMyLibrary ? 'Remove from My Library' : 'Add to My Library'}
      className={className}
    >
      {inMyLibrary ? '✓' : '+'}
    </button>
  )
}

function BookTile({
  book,
  inMyLibrary,
  onToggleLibrary,
}: {
  book: Book
  inMyLibrary?: boolean
  onToggleLibrary?: (e: React.MouseEvent) => void
}) {
  return (
    <Link to={`/book/${book.id}`} className="block">
      <div className="relative">
        <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
        <FormatBadge
          book={book}
          className="absolute right-1 top-1 rounded bg-slate-950/70 px-1 py-0.5 text-xs leading-none text-white"
        />
        {onToggleLibrary && (
          <LibraryToggleButton
            inMyLibrary={inMyLibrary ?? false}
            onToggle={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleLibrary(e)
            }}
            className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-950/70 text-xs text-white"
          />
        )}
      </div>
      <p className="mt-1 truncate text-sm text-primary">{book.title}</p>
      <p className="truncate text-xs text-muted">
        <BookSubtitle book={book} />
      </p>
      {/* A pure ebook/comic has no chapters, so totalDuration is 0 —
          showing "0m" next to it reads as broken, not as "this book has no
          runtime." Audio books and companion pairs (which use the audio
          side's totalDuration) always have a real value here. */}
      {book.totalDuration > 0 && <p className="text-xs text-subtle">{formatDuration(book.totalDuration)}</p>}
    </Link>
  )
}

function BookRow({
  book,
  inMyLibrary,
  onToggleLibrary,
}: {
  book: Book
  inMyLibrary?: boolean
  onToggleLibrary?: (e: React.MouseEvent) => void
}) {
  return (
    <Link to={`/book/${book.id}`} className="flex items-center gap-3 py-2">
      <div className="w-12 shrink-0">
        <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm text-primary">
          <FormatBadge book={book} className="text-xs" />
          {book.title}
        </p>
        <p className="truncate text-xs text-muted">
          {isComicFormat(book) ? (
            <BookSubtitle book={book} />
          ) : (
            <>
              {book.author}
              {book.seriesName && (
                <span className="text-subtle">
                  {' '}
                  · {book.seriesName}
                  {book.seriesNumber !== undefined && ` #${book.seriesNumber}`}
                </span>
              )}
            </>
          )}
        </p>
        {book.synopsis && <p className="line-clamp-2 text-xs text-subtle">{book.synopsis}</p>}
      </div>
      {onToggleLibrary && (
        <LibraryToggleButton
          inMyLibrary={inMyLibrary ?? false}
          onToggle={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggleLibrary(e)
          }}
          className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-secondary"
        />
      )}
      {book.totalDuration > 0 && (
        <p className="shrink-0 text-xs text-subtle">{formatDuration(book.totalDuration)}</p>
      )}
    </Link>
  )
}

export function BookGrid({
  books,
  displayMode,
  myLibraryIds,
  onToggleLibrary,
}: {
  books: Book[]
  displayMode: DisplayMode
  /** Only passed in Store mode — presence (even an empty Set) is what turns on the add/remove affordance. */
  myLibraryIds?: Set<string>
  onToggleLibrary?: (book: Book, currentlyIn: boolean) => void
}) {
  const showToggle = myLibraryIds !== undefined && onToggleLibrary !== undefined
  if (displayMode === 'row') {
    return (
      <ul className="divide-y divide-border">
        {books.map((book) => (
          <li key={book.id}>
            <BookRow
              book={book}
              inMyLibrary={myLibraryIds ? bookInLibrary(book, myLibraryIds) : undefined}
              onToggleLibrary={
                showToggle ? () => onToggleLibrary!(book, bookInLibrary(book, myLibraryIds!)) : undefined
              }
            />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-4">
      {books.map((book) => (
        <li key={book.id}>
          <BookTile
            book={book}
            inMyLibrary={myLibraryIds ? bookInLibrary(book, myLibraryIds) : undefined}
            onToggleLibrary={
              showToggle ? () => onToggleLibrary!(book, bookInLibrary(book, myLibraryIds!)) : undefined
            }
          />
        </li>
      ))}
    </ul>
  )
}
