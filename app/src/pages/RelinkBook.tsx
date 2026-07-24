import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  fetchBook,
  fetchRelinkCandidates,
  browseSource,
  previewRelink,
  confirmRelink,
  type ApiBookDetail,
  type ApiRelinkCandidate,
  type ApiBrowseEntry,
  type ApiRelinkPreview,
} from '../api/client'
import { LibraryError } from '../components/LibraryError'
import { formatDuration } from '../lib/format'

type Target = { path: string; format: 'm4b' | 'mp3_folder' }

export function RelinkBook() {
  const { bookId } = useParams()
  const navigate = useNavigate()

  const [book, setBook] = useState<ApiBookDetail | null>(null)
  const [candidates, setCandidates] = useState<ApiRelinkCandidate[]>([])
  const [loadError, setLoadError] = useState(false)

  const [browsing, setBrowsing] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [browseEntries, setBrowseEntries] = useState<ApiBrowseEntry[]>([])
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)

  const [target, setTarget] = useState<Target | null>(null)
  const [preview, setPreview] = useState<ApiRelinkPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    setLoadError(false)
    try {
      const [b, c] = await Promise.all([fetchBook(bookId!), fetchRelinkCandidates(bookId!)])
      setBook(b)
      setCandidates(c)
    } catch {
      setLoadError(true)
    }
  }, [bookId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!browsing || !book) return
    // A large real library's root folder can take a couple of seconds even
    // parallelized server-side (network filesystem latency) — without
    // `cancelled`, navigating to a second folder before the first request
    // resolves could let the stale first response overwrite the second
    // folder's already-loaded entries.
    let cancelled = false
    setBrowseError(null)
    setBrowseLoading(true)
    browseSource(book.source_id, browsePath)
      .then((entries) => {
        if (!cancelled) setBrowseEntries(entries)
      })
      .catch((err) => {
        if (!cancelled) setBrowseError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setBrowseLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [browsing, browsePath, book])

  async function selectTarget(t: Target) {
    setTarget(t)
    setPreview(null)
    setPreviewError(null)
    try {
      const p = await previewRelink(bookId!, t.path, t.format)
      setPreview(p)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Could not read that file')
    }
  }

  async function confirm() {
    if (!target) return
    setConfirming(true)
    try {
      await confirmRelink(bookId!, target.path, target.format)
      navigate(`/book/${bookId}`)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Relink failed')
      setConfirming(false)
    }
  }

  if (loadError) return <LibraryError onRetry={load} />
  if (!book) return <p className="px-4 pt-24 text-center text-muted">Loading…</p>

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <h1 className="text-xl font-semibold text-primary">Relink</h1>
      <p className="mt-1 text-sm text-muted">{book.title}</p>
      {book.author && <p className="text-xs text-subtle">{book.author}</p>}

      {target && (
        <div className="mt-6 rounded border border-border-strong p-4">
          <p className="text-sm text-primary">{target.path}</p>
          {previewError && <p className="mt-2 text-xs text-red-400">{previewError}</p>}
          {preview && (
            <div className="mt-3 text-xs text-muted">
              {preview.mismatchWarning && (
                <p className="mb-2 rounded bg-danger-soft px-3 py-2 text-danger-soft-text">
                  This doesn't quite match the original — double-check before confirming.
                </p>
              )}
              <div className="flex justify-between py-1">
                <span>Chapters</span>
                <span>
                  {preview.oldChapterCount} → {preview.newChapterCount}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span>Duration</span>
                <span>
                  {formatDuration(preview.oldDurationSeconds)} → {formatDuration(preview.newDurationSeconds)}
                </span>
              </div>
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => void confirm()}
              disabled={!preview || confirming}
              className="flex-1 rounded-lg bg-amber-400 py-2 text-sm font-medium text-slate-950 disabled:opacity-40"
            >
              {confirming ? 'Relinking…' : 'Confirm relink'}
            </button>
            <button
              onClick={() => {
                setTarget(null)
                setPreview(null)
                setPreviewError(null)
              }}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm text-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!target && !browsing && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Suggestions</p>
          {candidates.length === 0 && <p className="text-sm text-subtle">No likely matches found.</p>}
          <ul className="flex flex-col gap-2">
            {candidates.map((c) => (
              <li key={c.path}>
                <button
                  onClick={() => void selectTarget(c)}
                  className="w-full rounded border border-border-strong px-3 py-2 text-left text-sm text-primary"
                >
                  {c.path}
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={() => setBrowsing(true)}
            className="mt-4 text-xs text-amber-400 underline"
          >
            Browse instead
          </button>
        </div>
      )}

      {!target && browsing && (
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              /{browsePath}
            </p>
            <button
              onClick={() => (browsePath ? setBrowsePath(browsePath.split('/').slice(0, -1).join('/')) : setBrowsing(false))}
              className="text-xs text-muted"
            >
              ← Back
            </button>
          </div>
          {browseError && <p className="text-xs text-red-400">{browseError}</p>}
          {browseLoading && <p className="text-sm text-subtle">Loading…</p>}
          <ul className="flex flex-col gap-2">
            {!browseLoading && browseEntries.map((entry) => (
              <li key={entry.path} className="flex items-center gap-2">
                {entry.type === 'folder' ? (
                  <button
                    onClick={() => setBrowsePath(entry.path)}
                    className="flex-1 rounded border border-border-strong px-3 py-2 text-left text-sm text-primary"
                  >
                    {entry.name}/
                  </button>
                ) : (
                  <span className="flex-1 rounded border border-border px-3 py-2 text-sm text-muted">
                    {entry.name}
                  </span>
                )}
                {entry.selectable && entry.format && (
                  <button
                    onClick={() => void selectTarget({ path: entry.path, format: entry.format! })}
                    className="rounded border border-border-strong px-2 py-2 text-xs text-amber-400"
                  >
                    Use this
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
