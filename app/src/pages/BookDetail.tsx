import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  fetchBook,
  updateBook,
  fetchSagas,
  addSeriesToSaga,
  ApiError,
  type ApiBookDetail,
  type ApiSagaSummary,
} from '../api/client'
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
import { MetadataLookupDialog } from '../components/MetadataLookupDialog'
import { usePlayer } from '../player/PlayerContext'
import { logPlayerEvent } from '../player/playerDebugLog'
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
        <button
          onClick={() => void togglePicker()}
          className="flex-1 rounded-lg border border-border-strong py-2 text-sm text-primary"
        >
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

/**
 * Quick one-way entry point for tagging this book's *series* into a saga —
 * same split as AddToPlaylist above: a lightweight "add" action lives
 * here, but reordering/renaming/removing a series from a saga stays
 * Saga Detail's job exclusively (see the saga design conversation this
 * was built from). Only shown when the book has a series to tag (saga
 * membership is keyed by series_name, not by book) and isn't already in
 * one — once it is, the read-only "Part of [saga] →" link covers it;
 * changing sagas happens on Saga Detail, not by re-adding here.
 *
 * Adding one book's series already puts every other book sharing that
 * series_name in the saga too — series_sagas is keyed by series_name, not
 * per book, so there's no separate "apply to the whole series" step
 * needed.
 */
function AddToSaga({ seriesName, onAdded }: { seriesName: string; onAdded: (sagaName: string, position: number) => void }) {
  const [sagas, setSagas] = useState<ApiSagaSummary[] | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [newSagaName, setNewSagaName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function ensureSagasLoaded(): Promise<ApiSagaSummary[] | null> {
    if (sagas) return sagas
    try {
      const loaded = await fetchSagas()
      setSagas(loaded)
      return loaded
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server')
      return null
    }
  }

  async function addTo(sagaName: string) {
    const trimmed = sagaName.trim()
    if (!trimmed) return
    setError(null)
    setSubmitting(true)
    try {
      const updated = await addSeriesToSaga(trimmed, seriesName)
      const entry = updated.series.find((s) => s.series_name === seriesName)
      onAdded(updated.saga_name, entry?.position ?? 0)
      setShowPicker(false)
      setNewSagaName('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server')
    } finally {
      setSubmitting(false)
    }
  }

  async function togglePicker() {
    if (!showPicker) await ensureSagasLoaded()
    setShowPicker((v) => !v)
  }

  return (
    <div className="text-xs text-subtle">
      <button onClick={() => void togglePicker()} className="underline">
        + Add "{seriesName}" to a saga
      </button>

      {showPicker && (
        <div className="mt-2 rounded-lg border border-border-strong bg-background p-2">
          {sagas && sagas.length > 0 && (
            <div className="mb-2 space-y-1">
              {sagas.map((s) => (
                <button
                  key={s.saga_name}
                  onClick={() => void addTo(s.saga_name)}
                  disabled={submitting}
                  className="block w-full rounded px-2 py-1.5 text-left text-sm text-primary hover:bg-border disabled:opacity-50"
                >
                  {s.saga_name}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={newSagaName}
              onChange={(e) => setNewSagaName(e.target.value)}
              placeholder="New saga name"
              className="flex-1 rounded border border-border-strong bg-surface px-2 py-1 text-xs text-primary placeholder:text-subtle"
            />
            <button
              onClick={() => void addTo(newSagaName)}
              disabled={submitting || !newSagaName.trim()}
              className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-secondary disabled:opacity-40"
            >
              Add
            </button>
          </div>
          {error && <p className="mt-1 text-red-400">{error}</p>}
        </div>
      )}
    </div>
  )
}

interface MetadataPatch {
  title?: string
  titleSource?: null
  author?: string | null
  seriesName?: string | null
  seriesNumber?: number | null
  genre?: string | null
  narrator?: string | null
  arcName?: string | null
}

type MetadataField = 'title' | 'author' | 'seriesName' | 'seriesNumber' | 'genre' | 'narrator' | 'arcName'

const RESET_PATCH: Record<MetadataField, MetadataPatch> = {
  // title has no null/auto form of its own (the column can't be blank) —
  // titleSource: null un-pins it without touching the text, see
  // updateBook's own comment.
  title: { titleSource: null },
  author: { author: null },
  seriesName: { seriesName: null },
  seriesNumber: { seriesNumber: null },
  genre: { genre: null },
  narrator: { narrator: null },
  arcName: { arcName: null },
}

/**
 * Single unified editor for every per-book metadata field, replacing what
 * used to be three separate scattered inline editors (series, genre,
 * narrator — each with its own toggle-to-edit state) plus no way at all
 * to fix title/author despite the server already supporting it. One
 * dialog, one Save, one PATCH request. Modeled on FilterSheet.tsx's
 * bottom-sheet pattern (the one modal convention already in this app)
 * rather than inventing a new one.
 *
 * Every field shows a "Manual · Reset to auto" indicator whenever it's
 * currently pinned against future rescans — real feedback caught live:
 * without this, a field could get silently stuck on manual with no way
 * to tell, or (title specifically, before titleSource existed) no way
 * back to auto at all. Reset is an instant, separate action per field
 * (its own PATCH call) rather than something staged into the main Save,
 * since it's a distinct "undo the pin" intent, not a new value — the
 * dialog stays open afterward so several fields can be reset in one
 * sitting, or combined with editing others before a final Save.
 *
 * Deliberately does NOT include saga — saga membership/order is only
 * ever managed from the saga's own page (see the saga design
 * conversation this was built from), never edited from a book.
 */
function EditMetadataDialog({
  book,
  onClose,
  onSaved,
  onSagaAdded,
}: {
  book: Book
  onClose: () => void
  onSaved: (updated: ApiBookDetail) => void
  onSagaAdded: (sagaName: string, position: number) => void
}) {
  const [titleDraft, setTitleDraft] = useState(book.title)
  const [authorDraft, setAuthorDraft] = useState(book.author ?? '')
  const [seriesNameDraft, setSeriesNameDraft] = useState(book.seriesName ?? '')
  const [seriesNumberDraft, setSeriesNumberDraft] = useState(
    book.seriesNumber !== undefined ? String(book.seriesNumber) : '',
  )
  const [genreDraft, setGenreDraft] = useState(book.genre ?? '')
  const [narratorDraft, setNarratorDraft] = useState(book.narrator ?? '')
  const [arcNameDraft, setArcNameDraft] = useState(book.arcName ?? '')
  // Mirrors each field's current *Source — re-synced from the server's
  // response after every save/reset (see syncFromResponse) rather than
  // inferred client-side, so this can never drift from what's actually
  // persisted.
  const [manual, setManual] = useState<Record<MetadataField, boolean>>({
    title: book.titleSource === 'manual',
    author: book.authorSource === 'manual',
    seriesName: book.seriesNameSource === 'manual',
    seriesNumber: book.seriesNumberSource === 'manual',
    genre: book.genreSource === 'manual',
    narrator: book.narratorSource === 'manual',
    arcName: book.arcNameSource === 'manual',
  })
  const [saving, setSaving] = useState(false)
  const [resettingField, setResettingField] = useState<MetadataField | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Narrator is an audiobook-only field — same guard the old inline
  // editor used.
  const isAudio = book.format !== 'epub' && book.format !== 'cbz'
  const isComic = book.format === 'cbz'

  function syncFromResponse(updated: ApiBookDetail) {
    setManual({
      title: updated.title_source === 'manual',
      author: updated.author_source === 'manual',
      seriesName: updated.series_name_source === 'manual',
      seriesNumber: updated.series_number_source === 'manual',
      genre: updated.genre_source === 'manual',
      narrator: updated.narrator_source === 'manual',
      arcName: updated.arc_name_source === 'manual',
    })
    onSaved(updated)
  }

  async function handleReset(field: MetadataField) {
    setError(null)
    setResettingField(field)
    try {
      const updated = await updateBook(book.id, RESET_PATCH[field])
      syncFromResponse(updated)
      // Reflect the now-cleared value locally too — title is the one
      // exception, since resetting it never touches the text itself.
      if (field === 'author') setAuthorDraft('')
      if (field === 'seriesName') setSeriesNameDraft('')
      if (field === 'seriesNumber') setSeriesNumberDraft('')
      if (field === 'genre') setGenreDraft('')
      if (field === 'narrator') setNarratorDraft('')
      if (field === 'arcName') setArcNameDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResettingField(null)
    }
  }

  async function handleSave() {
    setError(null)
    const trimmedTitle = titleDraft.trim()
    if (!trimmedTitle) {
      setError('Title cannot be empty')
      return
    }
    const parsedSeriesNumber = seriesNumberDraft.trim() === '' ? null : Number(seriesNumberDraft)
    if (parsedSeriesNumber !== null && Number.isNaN(parsedSeriesNumber)) {
      setError('Series number must be a number')
      return
    }
    const trimmedAuthor = authorDraft.trim()
    const trimmedSeriesName = seriesNameDraft.trim()
    const trimmedNarrator = narratorDraft.trim()
    const trimmedArcName = arcNameDraft.trim()

    // Only a field that actually changed goes in the patch — matches the
    // server's manual-pin convention (a field's _source column only
    // flips to 'manual' when it's genuinely present in the PATCH body),
    // so leaving a field untouched here can't accidentally pin it.
    const patch: MetadataPatch = {}
    if (trimmedTitle !== book.title) patch.title = trimmedTitle
    if (trimmedAuthor !== (book.author ?? '')) patch.author = trimmedAuthor === '' ? null : trimmedAuthor
    if (trimmedSeriesName !== (book.seriesName ?? '')) patch.seriesName = trimmedSeriesName === '' ? null : trimmedSeriesName
    if (parsedSeriesNumber !== (book.seriesNumber ?? null)) patch.seriesNumber = parsedSeriesNumber
    if (genreDraft !== (book.genre ?? '')) patch.genre = genreDraft === '' ? null : genreDraft
    if (isAudio && trimmedNarrator !== (book.narrator ?? '')) patch.narrator = trimmedNarrator === '' ? null : trimmedNarrator
    if (isComic && trimmedArcName !== (book.arcName ?? '')) patch.arcName = trimmedArcName === '' ? null : trimmedArcName

    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }

    setSaving(true)
    try {
      const updated = await updateBook(book.id, patch)
      syncFromResponse(updated)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function FieldLabel({ field, children }: { field: MetadataField; children: string }) {
    return (
      <span className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{children}</span>
        {manual[field] && (
          <button
            type="button"
            onClick={() => void handleReset(field)}
            disabled={resettingField === field}
            className="shrink-0 whitespace-nowrap text-[10px] text-amber-400 underline disabled:opacity-50"
          >
            {resettingField === field ? 'Resetting…' : 'Manual · Reset to auto'}
          </button>
        )}
      </span>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 sm:items-center" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl bg-surface sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-strong px-4 py-3">
          <h2 className="text-sm font-semibold text-primary">Edit metadata</h2>
          <button onClick={onClose} className="text-xs text-subtle underline">
            Cancel
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <label className="block">
            <FieldLabel field="title">Title</FieldLabel>
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary"
            />
          </label>
          <label className="block">
            <FieldLabel field="author">Author</FieldLabel>
            <input
              type="text"
              value={authorDraft}
              onChange={(e) => setAuthorDraft(e.target.value)}
              className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary"
            />
          </label>
          <div className="flex gap-2">
            <label className="block flex-1">
              <FieldLabel field="seriesName">Series name</FieldLabel>
              <input
                type="text"
                value={seriesNameDraft}
                onChange={(e) => setSeriesNameDraft(e.target.value)}
                className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary"
              />
            </label>
            <label className="block w-20">
              <FieldLabel field="seriesNumber">#</FieldLabel>
              <input
                type="number"
                value={seriesNumberDraft}
                onChange={(e) => setSeriesNumberDraft(e.target.value)}
                className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary"
              />
            </label>
          </div>
          {/* Saga membership/order is only ever managed from the saga's
              own page (see the saga design conversation this was built
              from) — already in one, this is just a read-only link.
              Not in one yet, a quick "add" picker lives right here
              instead, same one-way-add-here/full-management-there split
              as AddToPlaylist elsewhere on this page. Based on the
              already-saved series name, not the draft above — add/save a
              series name first if it doesn't have one yet. */}
          <div className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Saga</span>
            {book.sagaName ? (
              <p className="text-sm text-primary">
                <Link to={`/sagas/${encodeURIComponent(book.sagaName)}`} className="underline" onClick={onClose}>
                  Part of the {book.sagaName}
                  {book.sagaPosition !== undefined && `, #${book.sagaPosition + 1}`} →
                </Link>
              </p>
            ) : book.seriesName ? (
              <AddToSaga seriesName={book.seriesName} onAdded={onSagaAdded} />
            ) : (
              <p className="text-xs text-subtle">Add a series name above first, then save, to add it to a saga.</p>
            )}
          </div>
          <label className="block">
            <FieldLabel field="genre">Genre</FieldLabel>
            <select
              value={genreDraft}
              onChange={(e) => setGenreDraft(e.target.value)}
              className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary"
            >
              <option value="">No genre</option>
              {GENRE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          {isAudio && (
            <label className="block">
              <FieldLabel field="narrator">Narrator</FieldLabel>
              <input
                type="text"
                value={narratorDraft}
                onChange={(e) => setNarratorDraft(e.target.value)}
                className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary"
              />
            </label>
          )}
          {isComic && (
            <label className="block">
              <FieldLabel field="arcName">Arc / collection</FieldLabel>
              <input
                type="text"
                value={arcNameDraft}
                onChange={(e) => setArcNameDraft(e.target.value)}
                placeholder="e.g. Death of the Family"
                className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary placeholder:text-subtle"
              />
            </label>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="border-t border-border-strong px-4 py-3">
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="w-full rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function downloadingLabel(progress: { loaded: number; total: number } | null): string {
  if (!progress || progress.total <= 0) return 'Downloading…'
  return `Downloading… ${Math.round((progress.loaded / progress.total) * 100)}%`
}

function DownloadBadge({
  book,
  downloads,
}: {
  book: Book
  downloads: ReturnType<typeof useDownloads>
}) {
  const cachedCount = book.chapters.filter((c) => downloads.isCached(c)).length
  const downloading = book.chapters.some((c) => downloads.isPending(c))
  if (cachedCount === 0) {
    return (
      <div>
        <button
          onClick={() => void downloads.downloadAll()}
          disabled={downloading}
          className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary disabled:opacity-60"
        >
          {downloading ? downloadingLabel(downloads.progress) : 'Download audiobook'}
        </button>
        {downloads.error && <p className="mt-1 text-xs text-red-400">{downloads.error}</p>}
      </div>
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
    <div>
      <button
        onClick={() => void downloads.downloadAll()}
        disabled={downloading}
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary disabled:opacity-60"
      >
        {downloading ? downloadingLabel(downloads.progress) : `${cachedCount}/${book.chapters.length} downloaded — finish`}
      </button>
      {downloads.error && <p className="mt-1 text-xs text-red-400">{downloads.error}</p>}
    </div>
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
    <div>
      <button
        onClick={() => void download.download()}
        disabled={download.pending}
        className="rounded border border-border-strong px-3 py-1.5 text-xs text-secondary disabled:opacity-40"
      >
        {download.pending ? 'Downloading…' : 'Download ebook'}
      </button>
      {download.error && <p className="mt-1 text-xs text-red-400">{download.error}</p>}
    </div>
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
    <div>
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
      {download.error && <p className="mt-1 text-xs text-red-400">{download.error}</p>}
    </div>
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
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showLookupDialog, setShowLookupDialog] = useState(false)
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

  const downloads = useDownloads(bookId!, partialBook?.chapters ?? [], partialBook?.format)
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
  // confusing; the "Download audiobook" badge above already covers it.
  const singleFile =
    book.chapters.length > 0 && book.chapters.every((c) => c.sourceFileId === book.chapters[0].sourceFileId)

  function playFrom(chapterId: string, resumeAt = 0) {
    player.loadBook(book, chapterId, resumeAt, true)
    navigate('/now-playing')
  }

  const hasProgress = !!book.progress && !progressCleared

  function playResume() {
    // TEMPORARY diagnostic (see playerDebugLog.ts) — this is the exact
    // moment a user-visible position regression would show up: whatever
    // this logs as `position` is what the player is about to resume from,
    // sourced from the reconcileProgress call in this page's own useAsync
    // fetcher above.
    logPlayerEvent('progress:resume', {
      bookId: book.id,
      hasProgress,
      chapterId: hasProgress ? book.progress?.chapterId : book.chapters[0]?.id,
      position: hasProgress && book.progress?.position.type === 'timestamp' ? Math.round(book.progress.position.value) : 0,
    })
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

  // Applies EditMetadataDialog's save/reset result — reads every relevant
  // field straight from the server's own fresh response rather than
  // tracking "what did the dialog just patch" here too, so this can never
  // drift from what's actually persisted (a reset, in particular, touches
  // columns — a cleared value, an un-pinned source — the dialog's own
  // patch object doesn't fully describe on its own). Mutated in place on
  // `book`, same as book.progress above (book is the useAsync-cached
  // object for this bookId, not re-fetched on every render, so this is
  // what makes an edit show up immediately here), plus the same update to
  // AppDataContext's own copy so Library/Store (reading from the shared
  // cache, not this page's local book) show it too, without a full
  // re-fetch. Only reachable once isFullyLoaded (see the Edit button
  // below), so `book` is always result.data at this point, never the
  // shared cached list item.
  function applyUpdatedBook(updated: ApiBookDetail) {
    // Re-derive via the same adapter the initial load uses, instead of
    // hand-picking fields here — a hand-picked list silently drifts out of
    // sync whenever a new field (e.g. cover art) is added elsewhere, which
    // is exactly what happened: the metadata-lookup flow can change
    // artwork_thumb_path/full_path, but this function never copied those
    // over, so a freshly-fetched cover never appeared until a full reload.
    const fields = adaptBookDetail(updated)
    Object.assign(book, fields)
    data.updateCachedBook(book.id, fields)
  }

  // AddToSaga's callback — same immediate-local-update pattern as
  // applyUpdatedBook above. Every other book sharing this series is now
  // in the saga too (series_sagas is keyed by series_name, not per book —
  // see AddToSaga's own comment), but only this page's own copy is
  // patched here; a sibling book's cached list entry picks up the badge
  // on the next natural data refresh rather than being hunted down and
  // patched individually.
  function applySagaAdd(sagaName: string, position: number) {
    const fields: Partial<Book> = { sagaName, sagaPosition: position }
    Object.assign(book, fields)
    data.updateCachedBook(book.id, fields)
    // Real bug caught live on SagaDetail.tsx's own reorder/remove/rename/
    // delete actions: sagaName/sagaPosition only get patched for *this*
    // book above, but every other book sharing the series is in the saga
    // too — their cached copies would otherwise show stale saga info
    // everywhere else (Library, Series Detail) until some unrelated
    // refresh happened to reload the catalog.
    data.invalidate()
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <button onClick={() => navigate(-1)} className="mb-4 inline-block text-sm text-muted underline">
        ← Back
      </button>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="w-40 shrink-0">
          <CoverArt title={book.title} coverUrl={book.coverFullUrl} />
        </div>
        <div className="min-w-0 text-center sm:flex-1 sm:text-left">
          <h1 className="text-xl font-semibold text-primary">{book.title}</h1>
          <p className="text-sm text-muted">{book.author}</p>
          {book.format !== 'epub' && book.format !== 'cbz' && book.narrator && (
            <p className="mt-1 text-xs text-subtle">Narrated by {book.narrator}</p>
          )}
          {book.seriesName && (
            <p className="mt-1 text-xs text-subtle">
              {book.seriesName}
              {book.seriesNumber !== undefined && ` #${book.seriesNumber}`}
            </p>
          )}
          {/* Read-only — saga membership/order is only ever managed from
              the saga's own page (see the saga design conversation this
              was built from). Not in one yet, "+ Add to a saga" lives in
              the "Edit metadata" dialog instead of as a separate control
              here, per Jim's own call. */}
          {book.sagaName && (
            <p className="mt-1 text-xs text-subtle">
              <Link to={`/sagas/${encodeURIComponent(book.sagaName)}`} className="underline">
                Part of the {book.sagaName}
                {book.sagaPosition !== undefined && `, #${book.sagaPosition + 1}`} →
              </Link>
            </p>
          )}
          {/* Comics only — the folder-derived arc/collection one level below
              seriesName (e.g. "No Man's Land" under "Batman"), same value
              Series Detail groups by. Editable via "Edit metadata" above,
              same manual-pin convention as title/author/series. */}
          {book.arcName && <p className="mt-1 text-xs text-subtle">{book.arcName}</p>}
          {book.genre && (
            <div className="mt-2 flex items-center justify-center gap-2 sm:justify-start">
              <span className="rounded-full border border-border-strong bg-surface px-2.5 py-0.5 text-xs text-secondary">
                {book.genre}
              </span>
            </div>
          )}
          {book.sourceLabel && <p className="text-xs text-subtle">{book.sourceLabel}</p>}
          {/* Held back until the full fetch lands (isFullyLoaded) — editing
              needs the real fetched `book` object, since applyMetadataPatch
              mutates it in place, and a fast tap before that lands could
              otherwise mutate the shared cached list item AppDataContext
              owns instead. */}
          {isFullyLoaded && (
            <div className="mt-2 flex items-center justify-center gap-3 sm:justify-start">
              <button onClick={() => setShowEditDialog(true)} className="text-xs text-amber-400 underline">
                Edit metadata
              </button>
              <button onClick={() => setShowLookupDialog(true)} className="text-xs text-amber-400 underline">
                Look up metadata online
              </button>
            </div>
          )}
        </div>
      </div>
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
        {isInMyLibrary ? '✓ In My Library' : '+ Add to My Library'}
      </button>

      {hasProgress && (
        <button
          onClick={() => void handleRemoveFromContinueListening()}
          className="mt-1 w-full text-center text-xs text-subtle underline"
        >
          Remove from In Progress
        </button>
      )}

      {/* Named playlists (add/reorder/remove/browse) are purely
          organizational and format-agnostic — only Up Next's auto-advance
          is audio-specific (tied to the <audio> element's native `ended`
          event in PlayerContext.tsx), and that's a separate concern from
          offering the add-to-playlist action here. See
          Ozzbooks_Addendum_PlaylistsForReading. */}
      <AddToPlaylist bookId={book.id} />

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

      {showEditDialog && (
        <EditMetadataDialog
          book={book}
          onClose={() => setShowEditDialog(false)}
          onSaved={applyUpdatedBook}
          onSagaAdded={applySagaAdd}
        />
      )}
      {showLookupDialog && (
        <MetadataLookupDialog book={book} onClose={() => setShowLookupDialog(false)} onApplied={applyUpdatedBook} />
      )}
    </div>
  )
}
