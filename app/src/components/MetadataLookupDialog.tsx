import { useState } from 'react'
import { lookupMetadata, applyMetadataLookup, ApiError, type ApiOpenLibraryCandidate, type ApiBookDetail } from '../api/client'
import type { Book } from '../types'

type Step = 'search' | 'results' | 'confirm'

type FieldKey = 'title' | 'author' | 'genre' | 'series' | 'synopsis' | 'cover'

// https://openlibrary.org/dev/docs/api/covers — publicly loadable by id,
// no auth/proxy needed for a preview thumbnail. The server only ever
// downloads the actual bytes (via fetchCover) once the user applies a
// cover, not for every candidate shown here.
function coverPreviewUrl(coverId: number): string {
  return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
}

/**
 * "Look up metadata online" — a per-book, human-reviewed alternative to
 * Settings' fully-automatic whole-library genre/cover backfill
 * (enrichBooks.ts), for exactly the case that one can't handle: the
 * auto-picked match was wrong, or missing, and someone needs to see the
 * actual candidates and choose. Three steps: search (title/author,
 * defaulted from the book but editable, for when the obvious query finds
 * the wrong book), results (every candidate Open Library returned, not
 * score-filtered — a human is reviewing, so a weak match stays visible to
 * reject rather than vanishing), confirm (per-field choice of what to
 * actually keep from the one candidate picked).
 */
export function MetadataLookupDialog({
  book,
  onClose,
  onApplied,
}: {
  book: Book
  onClose: () => void
  onApplied: (updated: ApiBookDetail) => void
}) {
  const [step, setStep] = useState<Step>('search')
  const [queryTitle, setQueryTitle] = useState(book.title)
  const [queryAuthor, setQueryAuthor] = useState(book.author ?? '')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<ApiOpenLibraryCandidate[]>([])
  const [selected, setSelected] = useState<ApiOpenLibraryCandidate | null>(null)
  // Identity fields default OFF — the existing title/author is presumably
  // already right (it's literally what found this candidate), so
  // overwriting it should be opt-in. Enrichment-style fields (genre,
  // series, synopsis, cover) default ON, since those are what someone
  // doing this lookup almost always wants filled in — cover art
  // especially, the most common reason to reach for this at all.
  const [checked, setChecked] = useState<Set<FieldKey>>(new Set(['genre', 'series', 'synopsis', 'cover']))
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  // Set instead of closing immediately — real bug caught live: a cover
  // genuinely not existing at Open Library (the search result's coverId
  // doesn't always resolve to a real image — see fetchCover's own "a 404
  // here is a stable, expected outcome, not a transient failure"
  // comment) used to close the dialog as if everything had applied, with
  // no sign the cover specifically hadn't. The other checked fields still
  // did apply by this point, so this only blocks the close, not the rest
  // of the apply.
  const [coverWarning, setCoverWarning] = useState<string | null>(null)

  async function handleSearch() {
    setSearchError(null)
    setSearching(true)
    try {
      const { candidates: found } = await lookupMetadata(book.id, {
        title: queryTitle.trim() || undefined,
        author: queryAuthor.trim() || undefined,
      })
      setCandidates(found)
      setStep('results')
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Could not reach the server')
    } finally {
      setSearching(false)
    }
  }

  function pickCandidate(candidate: ApiOpenLibraryCandidate) {
    setSelected(candidate)
    setChecked(
      new Set(
        (['genre', 'series', 'synopsis', 'cover'] as FieldKey[]).filter((f) => {
          if (f === 'genre') return candidate.genre !== null
          if (f === 'series') return candidate.series !== null
          if (f === 'cover') return candidate.coverId !== null
          return true // synopsis: unknown until fetched, offer it
        }),
      ),
    )
    setApplyError(null)
    setCoverWarning(null)
    setStep('confirm')
  }

  function toggleField(field: FieldKey) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(field)) next.delete(field)
      else next.add(field)
      return next
    })
  }

  async function handleApply() {
    if (!selected) return
    setApplyError(null)
    setCoverWarning(null)
    setApplying(true)
    try {
      const patch: Parameters<typeof applyMetadataLookup>[1] = { key: selected.key }
      if (checked.has('title')) patch.title = selected.title
      if (checked.has('author')) patch.author = selected.author
      if (checked.has('genre')) patch.genre = selected.genre
      if (checked.has('series')) patch.seriesName = selected.series
      if (checked.has('synopsis')) patch.synopsis = true
      if (checked.has('cover') && selected.coverId !== null) patch.coverId = selected.coverId

      const updated = await applyMetadataLookup(book.id, patch)
      onApplied(updated)
      if (checked.has('cover') && updated.cover_fetch_failed) {
        setCoverWarning("Everything else applied, but this cover image isn't available at Open Library — it may not actually exist for this edition.")
        return
      }
      onClose()
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : 'Could not reach the server')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 sm:items-center" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl bg-surface sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-strong px-4 py-3">
          <h2 className="text-sm font-semibold text-primary">Look up metadata online</h2>
          <button onClick={onClose} className="text-xs text-subtle underline">
            Cancel
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {step === 'search' && (
            <>
              <p className="text-xs text-subtle">
                Searches Open Library. Adjust the title/author below if the obvious search doesn't find the right
                book.
              </p>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Title</span>
                <input
                  type="text"
                  value={queryTitle}
                  onChange={(e) => setQueryTitle(e.target.value)}
                  className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Author</span>
                <input
                  type="text"
                  value={queryAuthor}
                  onChange={(e) => setQueryAuthor(e.target.value)}
                  className="w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-sm text-primary"
                />
              </label>
              {searchError && <p className="text-xs text-red-400">{searchError}</p>}
            </>
          )}

          {step === 'results' && (
            <>
              <button onClick={() => setStep('search')} className="text-xs text-muted underline">
                ‹ Change search
              </button>
              {candidates.length === 0 ? (
                <p className="px-1 py-2 text-center text-sm text-subtle">
                  No matches found. Try adjusting the title/author above.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {candidates.map((c) => (
                    <li key={c.key}>
                      <button
                        onClick={() => pickCandidate(c)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-border"
                      >
                        <div className="h-16 w-12 shrink-0 overflow-hidden rounded bg-background">
                          {c.coverId !== null && (
                            <img src={coverPreviewUrl(c.coverId)} alt="" className="h-full w-full object-cover" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-primary">{c.title}</p>
                          <p className="truncate text-xs text-muted">{c.author ?? 'Unknown author'}</p>
                          {(c.genre || c.series) && (
                            <p className="truncate text-xs text-subtle">
                              {[c.genre, c.series].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {step === 'confirm' && selected && (
            <>
              <button onClick={() => setStep('results')} className="text-xs text-muted underline">
                ‹ Back to results
              </button>
              <p className="text-xs text-subtle">
                Choose which fields to pull in from <span className="text-primary">{selected.title}</span>. Anything
                left unchecked keeps what this book already has.
              </p>

              <label className="flex items-start gap-2 text-sm text-primary">
                <input type="checkbox" checked={checked.has('title')} onChange={() => toggleField('title')} className="mt-1 h-4 w-4 shrink-0" />
                <span>
                  <span className="block text-xs font-medium uppercase tracking-wide text-muted">Title</span>
                  {book.title} → {selected.title}
                </span>
              </label>

              <label className="flex items-start gap-2 text-sm text-primary">
                <input type="checkbox" checked={checked.has('author')} onChange={() => toggleField('author')} className="mt-1 h-4 w-4 shrink-0" />
                <span>
                  <span className="block text-xs font-medium uppercase tracking-wide text-muted">Author</span>
                  {book.author || '(none)'} → {selected.author ?? '(none)'}
                </span>
              </label>

              {selected.genre !== null && (
                <label className="flex items-start gap-2 text-sm text-primary">
                  <input type="checkbox" checked={checked.has('genre')} onChange={() => toggleField('genre')} className="mt-1 h-4 w-4 shrink-0" />
                  <span>
                    <span className="block text-xs font-medium uppercase tracking-wide text-muted">Genre</span>
                    {book.genre ?? '(none)'} → {selected.genre}
                  </span>
                </label>
              )}

              {selected.series !== null && (
                <label className="flex items-start gap-2 text-sm text-primary">
                  <input type="checkbox" checked={checked.has('series')} onChange={() => toggleField('series')} className="mt-1 h-4 w-4 shrink-0" />
                  <span>
                    <span className="block text-xs font-medium uppercase tracking-wide text-muted">Series</span>
                    {book.seriesName ?? '(none)'} → {selected.series}
                  </span>
                </label>
              )}

              <label className="flex items-start gap-2 text-sm text-primary">
                <input type="checkbox" checked={checked.has('synopsis')} onChange={() => toggleField('synopsis')} className="mt-1 h-4 w-4 shrink-0" />
                <span>
                  <span className="block text-xs font-medium uppercase tracking-wide text-muted">Synopsis</span>
                  {book.synopsis ? 'Replace existing synopsis' : 'Fill in synopsis'} (fetched when applied)
                </span>
              </label>

              {selected.coverId !== null && (
                <label className="flex items-start gap-2 text-sm text-primary">
                  <input type="checkbox" checked={checked.has('cover')} onChange={() => toggleField('cover')} className="mt-1 h-4 w-4 shrink-0" />
                  <div className="flex items-center gap-2">
                    <div className="h-16 w-12 shrink-0 overflow-hidden rounded bg-background">
                      <img src={coverPreviewUrl(selected.coverId)} alt="" className="h-full w-full object-cover" />
                    </div>
                    <span>
                      <span className="block text-xs font-medium uppercase tracking-wide text-muted">Cover</span>
                      Replace cover art
                    </span>
                  </div>
                </label>
              )}

              {applyError && <p className="text-xs text-red-400">{applyError}</p>}
              {coverWarning && <p className="text-xs text-amber-400">{coverWarning}</p>}
            </>
          )}
        </div>

        <div className="border-t border-border-strong px-4 py-3">
          {step === 'search' && (
            <button
              onClick={() => void handleSearch()}
              disabled={searching || !queryTitle.trim()}
              className="w-full rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50"
            >
              {searching ? 'Searching…' : 'Search'}
            </button>
          )}
          {step === 'confirm' &&
            (coverWarning ? (
              <button
                onClick={onClose}
                className="w-full rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950"
              >
                Done
              </button>
            ) : (
              <button
                onClick={() => void handleApply()}
                disabled={applying || checked.size === 0}
                className="w-full rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50"
              >
                {applying ? 'Applying…' : `Apply ${checked.size} field${checked.size === 1 ? '' : 's'}`}
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}
