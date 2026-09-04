import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchBook, updateBook } from '../api/client'
import { adaptBookDetail } from '../api/adapter'
import { reconcileProgress, removeFromContinueListening } from '../offline/reconcile'
import { getCachedBookDetail, putCachedBookDetail } from '../offline/bookDetailCacheStore'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { useDownloads } from '../hooks/useDownloads'
import { useEbookDownload } from '../hooks/useEbookDownload'
import { useComicDownload } from '../hooks/useComicDownload'
import { useAppData } from '../data/AppDataContext'
import { CoverArt } from '../components/CoverArt'
import { LibraryError } from '../components/LibraryError'
import { usePlayer } from '../player/PlayerContext'
import { formatClock, formatDuration } from '../lib/format'
import { bookInLibrary } from '../library/companion'
import { GENRE_OPTIONS } from '../library/genreOptions'
import { fetchPlaylists, addToPlaylist, findUpNext, CloudApiError, type Playlist } from '../api/cloudClient'
import type { Book } from '../types'

function AddToPlaylist({ bookId }: { bookId: string }) {
  const auth = useAuth()
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function ensurePlaylistsLoaded(): Promise<Playlist[] | null> {
    if (playlists) return playlists
    if (!auth.token) return null
    try {
      const loaded = await fetchPlaylists(auth.token)
      setPlaylists(loaded)
      return loaded
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
      return null
    }
  }

  async function addTo(playlist: Playlist) {
    if (!auth.token) return
    setError(null)
    try {
      await addToPlaylist(auth.token, playlist.id, bookId)
      setFeedback(`Added to ${playlist.name}`)
      setShowPicker(false)
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
    }
  }

  async function handleAddToUpNext() {
    const loaded = await ensurePlaylistsLoaded()
    const upNext = loaded && findUpNext(loaded)
    if (upNext) void addTo(upNext)
  }

  async function togglePicker() {
    if (!showPicker) await ensurePlaylistsLoaded()
    setShowPicker((v) => !v)
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleAddToUpNext()}
          className="flex-1 rounded-lg border border-border-strong py-2 text-sm text-primary"
        >
          + Add to Up Next
        </button>
        <button onClick={() => void togglePicker()} className="text-sm text-amber-400 underline">
          Add to a playlist…
        </button>
      </div>

      {showPicker && playlists && (
        <div className="mt-2 rounded-lg border border-border-strong bg-surface p-2 shadow-lg">
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => void addTo(p)}
              className="block w-full rounded px-3 py-2 text-left text-sm text-primary hover:bg-border"
            >
              {p.is_reserved ? '▶️ ' : ''}
              {p.name}
            </button>
          ))}
        </div>
      )}

      {feedback && <p className="mt-1 text-center text-xs text-emerald-400">{feedback}</p>}
      {error && <p className="mt-1 text-center text-xs text-red-400">{error}</p>}
    </div>
  )
}

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
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary"
      >
        Download whole book
      </button>
    )
  }
  if (cachedCount === book.chapters.length) {
    return (
      <button
        onClick={() => void downloads.removeAll()}
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-amber-400"
      >
        Downloaded — remove
      </button>
    )
  }
  return (
    <button
      onClick={() => void downloads.downloadAll()}
      className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary"
    >
      {cachedCount}/{book.chapters.length} downloaded — finish
    </button>
  )
}

// A single file, not N chapters sharing M source files like audio — no
// partial-progress state, just cached or not.
function EbookDownloadBadge({ download }: { download: ReturnType<typeof useEbookDownload> }) {
  if (download.cached) {
    return (
      <button
        onClick={() => void download.remove()}
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-amber-400"
      >
        Ebook downloaded — remove
      </button>
    )
  }
  return (
    <button
      onClick={() => void download.download()}
      disabled={download.pending}
      className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary disabled:opacity-40"
    >
      {download.pending ? 'Downloading…' : 'Download ebook'}
    </button>
  )
}

// Whole-issue downloads only, same single-aggregate-state shape as
// EbookDownloadBadge above (not DownloadBadge's per-chapter list) — a
// comic has no chapters to enumerate, and the user only ever sees one
// cached/downloading/not-cached state even though N page images are
// fetched underneath. See Ozzbooks_Addendum_Comics' Offline download
// experience section.
function ComicDownloadBadge({ book, download }: { book: Book; download: ReturnType<typeof useComicDownload> }) {
  if (download.complete) {
    return (
      <button
        onClick={() => void download.remove()}
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-amber-400"
      >
        Downloaded — remove
      </button>
    )
  }
  const pageCount = book.pageCount ?? 0
  return (
    <button
      onClick={() => void download.download()}
      disabled={download.pending || pageCount === 0}
      className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary disabled:opacity-40"
    >
      {download.pending
        ? `${download.cachedCount}/${pageCount} downloaded…`
        : download.cachedCount > 0
          ? `${download.cachedCount}/${pageCount} downloaded — finish`
          : 'Download whole book'}
    </button>
  )
}

export function BookDetail() {
  const { bookId } = useParams()
  const navigate = useNavigate()
  const player = usePlayer()
  const auth = useAuth()
  const data = useAppData()
  // `book.progress` is set by mutating the fetched object in-place below
  // (see the useAsync fetcher), so it won't trigger a re-render on its own
  // when cleared — this local flag is what actually drives the UI after a
  // removal, independent of that object identity.
  const [progressCleared, setProgressCleared] = useState(false)
  const [editingSeries, setEditingSeries] = useState(false)
  const [seriesNameDraft, setSeriesNameDraft] = useState('')
  const [seriesNumberDraft, setSeriesNumberDraft] = useState('')
  const [seriesError, setSeriesError] = useState<string | null>(null)
  const [editingGenre, setEditingGenre] = useState(false)
  const [genreDraft, setGenreDraft] = useState('')
  const [genreError, setGenreError] = useState<string | null>(null)
  const [editingNarrator, setEditingNarrator] = useState(false)
  const [narratorDraft, setNarratorDraft] = useState('')
  const [narratorError, setNarratorError] = useState<string | null>(null)
  const result = useAsync(async () => {
    const [book, progress] = await Promise.all([
      fetchBook(bookId!).then(adaptBookDetail),
      reconcileProgress(auth.token, bookId!),
    ])
    if (progress) {
      // book.chapters[0] doesn't exist for an epub-only book (ebook
      // reading position is CFI-based, not chapter-based, so its saved
      // progress rows never have a real chapterId to begin with) — fall
      // back to '' instead of crashing on chapters[0].id for that case.
      book.progress = { position: progress.position, chapterId: progress.chapterId || book.chapters[0]?.id || '' }
    }
    void putCachedBookDetail(bookId!, book)
    return book
  }, [bookId])

  // The *full* detail (chapters included) from a previous successful
  // visit, if any — distinct from the list-item prefill below, and loaded
  // in parallel with the network fetch rather than blocking on it. This is
  // what makes an already-downloaded audiobook actually playable with no
  // server connection: the list-item shape has no chapters, so without
  // this a network failure would strand you on a book you can't press
  // Play on even though the audio file itself is sitting in IndexedDB.
  const [cachedFullDetail, setCachedFullDetail] = useState<Book | null>(null)
  useEffect(() => {
    let cancelled = false
    setCachedFullDetail(null)
    void getCachedBookDetail(bookId!).then((entry) => {
      if (!cancelled && entry) setCachedFullDetail(entry.book)
    })
    return () => {
      cancelled = true
    }
  }, [bookId])

  // AppDataContext's book list already has this book's title/author/cover/
  // format/companionBookId (everything except chapters, synopsis, and
  // source label — the list-item shape) from the last time the catalog was
  // fetched. Showing that immediately, instead of a bare "Loading…", is
  // what actually fixes "opening a book feels slow" — the full fetch
  // (below) still runs for chapters/synopsis, but the page paints right
  // away instead of waiting on it.
  const cachedListItem = data.books.find((b) => b.id === bookId)
  const isFullyLoaded = result.status === 'success'
  // Possibly undefined for one render (neither the full fetch nor either
  // cache has resolved yet) — every hook below tolerates that via `?? []`/
  // optional chaining, since hooks must run unconditionally before the
  // early returns further down decide whether there's anything to render.
  // Priority: fresh fetch > cached full detail (has real chapters, so
  // still playable/readable offline) > list-item prefill (title/cover
  // only, from AppDataContext).
  const partialBook = isFullyLoaded ? result.data : (cachedFullDetail ?? cachedListItem)

  const downloads = useDownloads(bookId!, partialBook?.chapters ?? [])
  const epubIdForDownload = partialBook && (partialBook.format === 'epub' ? partialBook.id : partialBook.companionBookId)
  const ebookDownload = useEbookDownload(epubIdForDownload)
  const comicDownload = useComicDownload(
    partialBook?.format === 'cbz' ? partialBook.id : undefined,
    partialBook?.format === 'cbz' ? partialBook.pageCount : undefined,
  )

  // The error screen only wins when there's truly nothing to show — a
  // network failure with a cached book (full or partial) available
  // renders normally instead, same "stale beats a hard block" principle
  // as AppDataContext.
  if (!partialBook) {
    if (result.status === 'error') {
      return <LibraryError onRetry={result.retry} error={result.error} />
    }
    return <p className="px-4 pt-24 text-center text-muted">Loading…</p>
  }
  // Re-bound with an explicit type (rather than just using partialBook
  // from here on) — TS's control-flow narrowing from the guard above
  // doesn't carry into the nested function declarations below that close
  // over it (playFrom, saveSeries, etc.), so it'd still see
  // `Book | undefined` there. Declaring a fresh `const book: Book`
  // sidesteps that entirely.
  const book: Book = partialBook

  const isInMyLibrary = bookInLibrary(book, data.myLibraryIds)

  async function handleToggleLibrary() {
    await data.toggleLibraryMembership(book, !isInMyLibrary)
  }

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

  const hasProgress = !!book.progress && !progressCleared

  function playResume() {
    if (hasProgress && book.progress && book.progress.position.type === 'timestamp') {
      playFrom(book.progress.chapterId, book.progress.position.value)
    } else {
      playFrom(book.chapters[0].id)
    }
  }

  async function handleRemoveFromContinueListening() {
    setProgressCleared(true)
    try {
      await removeFromContinueListening(auth.token, book.id)
    } catch {
      setProgressCleared(false)
    }
  }

  function startEditingSeries() {
    setSeriesError(null)
    setSeriesNameDraft(book.seriesName ?? '')
    setSeriesNumberDraft(book.seriesNumber !== undefined ? String(book.seriesNumber) : '')
    setEditingSeries(true)
  }

  async function saveSeries() {
    setSeriesError(null)
    const trimmedName = seriesNameDraft.trim()
    const parsedNumber = seriesNumberDraft.trim() === '' ? null : Number(seriesNumberDraft)
    if (parsedNumber !== null && Number.isNaN(parsedNumber)) {
      setSeriesError('Series number must be a number')
      return
    }
    try {
      await updateBook(book.id, { seriesName: trimmedName === '' ? null : trimmedName, seriesNumber: parsedNumber })
      const patch = { seriesName: trimmedName === '' ? undefined : trimmedName, seriesNumber: parsedNumber ?? undefined }
      // Mutated in place, same as book.progress above — book is the
      // useAsync-cached object for this bookId, not re-fetched on every
      // render, so this is what makes the edit show up immediately here.
      // Only reachable once isFullyLoaded (see the Edit button above), so
      // `book` is always result.data at this point, never the shared
      // cached list item.
      book.seriesName = patch.seriesName
      book.seriesNumber = patch.seriesNumber
      // AppDataContext's own copy needs the same update so Library/Store
      // (reading from the shared cache, not this page's local book) show
      // the edit too, without a full re-fetch.
      data.updateCachedBook(book.id, patch)
      setEditingSeries(false)
    } catch (err) {
      setSeriesError(err instanceof Error ? err.message : String(err))
    }
  }

  function startEditingGenre() {
    setGenreError(null)
    setGenreDraft(book.genre ?? '')
    setEditingGenre(true)
  }

  async function saveGenre() {
    setGenreError(null)
    try {
      await updateBook(book.id, { genre: genreDraft === '' ? null : genreDraft })
      const patch = { genre: genreDraft === '' ? undefined : genreDraft }
      book.genre = patch.genre
      data.updateCachedBook(book.id, patch)
      setEditingGenre(false)
    } catch (err) {
      setGenreError(err instanceof Error ? err.message : String(err))
    }
  }

  function startEditingNarrator() {
    setNarratorError(null)
    setNarratorDraft(book.narrator ?? '')
    setEditingNarrator(true)
  }

  async function saveNarrator() {
    setNarratorError(null)
    const trimmed = narratorDraft.trim()
    try {
      await updateBook(book.id, { narrator: trimmed === '' ? null : trimmed })
      const patch = { narrator: trimmed === '' ? undefined : trimmed }
      book.narrator = patch.narrator
      data.updateCachedBook(book.id, patch)
      setEditingNarrator(false)
    } catch (err) {
      setNarratorError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <div className="mx-auto w-40">
        <CoverArt title={book.title} coverUrl={book.coverFullUrl} />
      </div>
      <h1 className="mt-4 text-center text-xl font-semibold text-primary">{book.title}</h1>
      <p className="text-center text-sm text-muted">{book.author}</p>
      {book.format !== 'epub' &&
        (editingNarrator ? (
          <div className="mt-1 flex items-center justify-center gap-2">
            <input
              type="text"
              value={narratorDraft}
              onChange={(e) => setNarratorDraft(e.target.value)}
              placeholder="Narrator"
              className="w-40 rounded border border-border-strong bg-surface px-2 py-1 text-center text-xs text-primary placeholder:text-subtle"
            />
            <button onClick={() => void saveNarrator()} className="text-xs text-amber-400 underline">
              Save
            </button>
            <button onClick={() => setEditingNarrator(false)} className="text-xs text-subtle underline">
              Cancel
            </button>
          </div>
        ) : (
          <p className="text-center text-xs text-subtle">
            {book.narrator && <>Narrated by {book.narrator} </>}
            {isFullyLoaded && (
              <button onClick={startEditingNarrator} className="underline">
                {book.narrator ? 'Edit' : '+ Add narrator'}
              </button>
            )}
          </p>
        ))}
      {narratorError && <p className="mt-1 text-center text-xs text-red-400">{narratorError}</p>}
      {editingSeries ? (
        <div className="mt-2 flex items-center justify-center gap-2">
          <input
            type="text"
            value={seriesNameDraft}
            onChange={(e) => setSeriesNameDraft(e.target.value)}
            placeholder="Series name"
            className="w-32 rounded border border-border-strong bg-surface px-2 py-1 text-center text-xs text-primary placeholder:text-subtle"
          />
          <input
            type="number"
            value={seriesNumberDraft}
            onChange={(e) => setSeriesNumberDraft(e.target.value)}
            placeholder="#"
            className="w-14 rounded border border-border-strong bg-surface px-2 py-1 text-center text-xs text-primary placeholder:text-subtle"
          />
          <button onClick={() => void saveSeries()} className="text-xs text-amber-400 underline">
            Save
          </button>
          <button onClick={() => setEditingSeries(false)} className="text-xs text-subtle underline">
            Cancel
          </button>
        </div>
      ) : (
        <p className="mt-1 text-center text-xs text-subtle">
          {book.seriesName && (
            <>
              {book.seriesName}
              {book.seriesNumber !== undefined && ` #${book.seriesNumber}`}
              {book.seriesName && isFullyLoaded && ' · '}
            </>
          )}
          {/* Editing needs the real fetched `book` object (saveSeries
              mutates it in place) — held back until the full fetch lands
              so a fast tap can't ever mutate the shared cached list item
              AppDataContext owns instead. */}
          {isFullyLoaded && (
            <button onClick={startEditingSeries} className="underline">
              {book.seriesName ? 'Edit' : '+ Add series info'}
            </button>
          )}
        </p>
      )}
      {seriesError && <p className="mt-1 text-center text-xs text-red-400">{seriesError}</p>}
      <div className="mt-2 flex items-center justify-center gap-2">
        {editingGenre ? (
          <>
            <select
              value={genreDraft}
              onChange={(e) => setGenreDraft(e.target.value)}
              className="rounded border border-border-strong bg-surface px-2 py-1 text-center text-xs text-primary"
            >
              <option value="">No genre</option>
              {GENRE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <button onClick={() => void saveGenre()} className="text-xs text-amber-400 underline">
              Save
            </button>
            <button onClick={() => setEditingGenre(false)} className="text-xs text-subtle underline">
              Cancel
            </button>
          </>
        ) : book.genre ? (
          <button
            onClick={() => isFullyLoaded && startEditingGenre()}
            className="rounded-full border border-border-strong bg-surface px-2.5 py-0.5 text-xs text-secondary"
          >
            {book.genre}
          </button>
        ) : (
          isFullyLoaded && (
            <button onClick={startEditingGenre} className="text-xs text-subtle underline">
              + Add genre
            </button>
          )
        )}
      </div>
      {genreError && <p className="mt-1 text-center text-xs text-red-400">{genreError}</p>}
      {book.sourceLabel && <p className="text-center text-xs text-subtle">{book.sourceLabel}</p>}
      {book.status === 'missing' && (
        <div className="mt-2 rounded bg-danger-soft px-3 py-2 text-center text-xs text-danger-soft-text">
          <p>This book's source file couldn't be found. Progress and bookmarks are kept.</p>
          {isInMyLibrary && (
            <p className="mt-1">
              It'll be cleaned up by the library's normal missing-book housekeeping if nobody relinks it.
            </p>
          )}
          <div className="mt-2 flex items-center justify-center gap-3">
            <button onClick={() => navigate(`/book/${bookId}/relink`)} className="underline">
              Relink
            </button>
            {isInMyLibrary && (
              <button onClick={() => void handleToggleLibrary()} className="underline">
                Remove from My Library
              </button>
            )}
          </div>
        </div>
      )}

      {book.companionBookId ? (
        // A companion pair — equal-weight side by side, so neither format
        // reads as the "real" book and the other as an afterthought.
        <div className="mt-4 flex gap-2">
          {book.format === 'epub' ? (
            <>
              <button
                onClick={() => navigate(`/book/${book.id}/read`)}
                className="flex-1 rounded-lg bg-amber-400 py-3 font-medium text-slate-950"
              >
                📖 {hasProgress ? 'Keep Reading' : 'Read'}
              </button>
              <button
                onClick={() => navigate(`/book/${book.companionBookId}`)}
                className="flex-1 rounded-lg bg-amber-400 py-3 font-medium text-slate-950"
              >
                🎧 Listen
              </button>
            </>
          ) : (
            <>
              <button
                onClick={playResume}
                disabled={book.status === 'missing' || book.chapters.length === 0}
                className="flex-1 rounded-lg bg-amber-400 py-3 font-medium text-slate-950 disabled:opacity-40"
              >
                🎧 {hasProgress ? 'Keep Listening' : 'Play'}
              </button>
              <button
                onClick={() => navigate(`/book/${book.companionBookId}/read`)}
                className="flex-1 rounded-lg bg-amber-400 py-3 font-medium text-slate-950"
              >
                📖 Read
              </button>
            </>
          )}
        </div>
      ) : book.format === 'epub' || book.format === 'cbz' ? (
        <button
          onClick={() => navigate(`/book/${book.id}/read`)}
          className="mt-4 w-full rounded-lg bg-amber-400 py-3 font-medium text-slate-950"
        >
          {hasProgress ? 'Keep Reading' : 'Read'}
        </button>
      ) : (
        <button
          onClick={playResume}
          disabled={book.status === 'missing' || book.chapters.length === 0}
          className="mt-4 w-full rounded-lg bg-amber-400 py-3 font-medium text-slate-950 disabled:opacity-40"
        >
          {hasProgress ? 'Keep Listening' : 'Play'}
        </button>
      )}

      <button
        onClick={() => void handleToggleLibrary()}
        className="mt-2 w-full rounded-lg border border-border-strong py-2 text-sm text-secondary"
      >
        {isInMyLibrary ? '✓ On My Library' : '+ Add to My Library'}
      </button>

      {hasProgress && (
        <button
          onClick={() => void handleRemoveFromContinueListening()}
          className="mt-1 w-full text-center text-xs text-subtle underline"
        >
          Remove from In Progress
        </button>
      )}

      {/* Up Next/playlists are an audio queue (NowPlaying's auto-advance
          loads the next item straight into the audio player) — offering
          it on a page with no chapters to play doesn't make sense. Hidden
          here rather than on the epub format check alone so a companion
          pair's epub-side page also hides it; its own "Listen" button
          already sends you to the audio side's page, which has this. */}
      {book.format !== 'epub' && <AddToPlaylist bookId={book.id} />}

      <div className="mt-3 flex items-center justify-between">
        {/* A pure ebook has no chapters, so totalDuration is 0 — see the
            matching guard in Library.tsx's BookTile/BookRow. */}
        {book.totalDuration > 0 && <p className="text-xs text-subtle">{formatDuration(book.totalDuration)} total</p>}
        <div className="flex items-center gap-2">
          {book.format !== 'epub' && book.format !== 'cbz' && <DownloadBadge book={book} downloads={downloads} />}
          {epubIdForDownload && <EbookDownloadBadge download={ebookDownload} />}
          {book.format === 'cbz' && <ComicDownloadBadge book={book} download={comicDownload} />}
        </div>
      </div>

      {book.synopsis && (
        <div className="mt-6">
          <p className="text-sm font-medium text-primary">Synopsis</p>
          <p className="mt-2 whitespace-pre-line text-sm text-muted">{book.synopsis}</p>
        </div>
      )}

      {/* Only when there really are no chapters to show yet — the
          cachedFullDetail fallback above can already have real chapters
          even when !isFullyLoaded (offline, showing a previously-cached
          full detail), and showing this text above an already-populated
          chapter list would be confusing. */}
      {!isFullyLoaded && book.chapters.length === 0 && (
        <p className="mt-6 text-center text-xs text-subtle">Loading chapters…</p>
      )}

      <ul className="mt-6 divide-y divide-border">
        {book.chapters.map((chapter) => (
          <li key={chapter.id} className="flex items-center justify-between py-3">
            <button
              onClick={() => playFrom(chapter.id)}
              disabled={book.status === 'missing'}
              className="flex-1 text-left disabled:opacity-40"
            >
              {/* A chapter's embedded title can look exactly like a
                  standalone filename (e.g. merged multi-part rips that
                  kept each original part's name as its chapter title,
                  "Book 10 - Small Favor #01") — easy to mistake for a
                  separate file rather than a chapter of this book.
                  Always showing the chapter's own number first makes it
                  read as "chapter N" no matter what the embedded title
                  says. */}
              <span className="text-sm text-primary">
                <span className="text-subtle">{chapter.index + 1}.</span> {chapter.title}
              </span>
            </button>
            <span className="text-xs text-subtle">{formatClock(chapter.duration)}</span>
            {!singleFile && (
              <button
                onClick={() =>
                  void (downloads.isCached(chapter) ? downloads.remove(chapter) : downloads.download(chapter))
                }
                disabled={downloads.isPending(chapter)}
                aria-label={downloads.isCached(chapter) ? 'Remove download' : 'Download chapter'}
                className="ml-3 text-lg text-muted disabled:opacity-40"
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
