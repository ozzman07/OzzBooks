import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { fetchBooks } from '../api/client'
import { adaptBookListItem } from '../api/adapter'
import { CoverArt } from '../components/CoverArt'
import { formatDuration } from '../lib/format'
import type { Book } from '../types'
import {
  fetchPlaylist,
  renamePlaylist,
  deletePlaylist,
  removeFromPlaylist,
  reorderPlaylist,
  CloudApiError,
  type PlaylistWithItems,
  type PlaylistItem,
} from '../api/cloudClient'

export function PlaylistDetail() {
  const { playlistId } = useParams<{ playlistId: string }>()
  const auth = useAuth()
  const navigate = useNavigate()

  const [playlist, setPlaylist] = useState<PlaylistWithItems | null>(null)
  const [byBookId, setByBookId] = useState<Map<string, Book>>(new Map())
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const result = useAsync(async () => {
    if (!auth.token || !playlistId) return null
    const [pl, books] = await Promise.all([
      fetchPlaylist(auth.token, playlistId),
      fetchBooks().then((rows) => rows.map(adaptBookListItem)),
    ])
    return { pl, books }
  }, [auth.token, playlistId])

  useEffect(() => {
    if (result.status !== 'success' || !result.data) return
    setPlaylist(result.data.pl)
    setByBookId(new Map(result.data.books.map((b) => [b.id, b])))
    setNameDraft(result.data.pl.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.status])

  if (result.status === 'loading' || !playlist) {
    return <p className="px-4 pt-24 text-center text-muted">Loading…</p>
  }
  if (result.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 px-6 pt-24 text-center text-muted">
        <p className="text-lg text-primary">Can't reach this playlist right now</p>
        <button
          onClick={result.retry}
          className="mt-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950"
        >
          Retry
        </button>
      </div>
    )
  }

  async function move(index: number, direction: -1 | 1) {
    if (!auth.token || !playlist) return
    const items = playlist.items.slice()
    const target = index + direction
    if (target < 0 || target >= items.length) return
    ;[items[index], items[target]] = [items[target], items[index]]
    setPlaylist({ ...playlist, items }) // optimistic — a tap is deliberate and infrequent, not worth waiting on
    setActionError(null)
    try {
      const updated = await reorderPlaylist(
        auth.token,
        playlist.id,
        items.map((i) => i.id),
      )
      setPlaylist((p) => (p ? { ...p, items: updated } : p))
    } catch (err) {
      setActionError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
      result.retry()
    }
  }

  async function remove(item: PlaylistItem) {
    if (!auth.token || !playlist) return
    setActionError(null)
    const items = playlist.items.filter((i) => i.id !== item.id)
    setPlaylist({ ...playlist, items })
    try {
      await removeFromPlaylist(auth.token, playlist.id, item.id)
    } catch (err) {
      setActionError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
      result.retry()
    }
  }

  async function saveRename() {
    if (!auth.token || !playlist || !nameDraft.trim()) return
    try {
      const updated = await renamePlaylist(auth.token, playlist.id, nameDraft.trim())
      setPlaylist({ ...playlist, name: updated.name })
      setRenaming(false)
    } catch (err) {
      setActionError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
    }
  }

  async function handleDelete() {
    if (!auth.token || !playlist) return
    if (!window.confirm(`Delete "${playlist.name}"? This can't be undone.`)) return
    try {
      await deletePlaylist(auth.token, playlist.id)
      navigate('/playlists')
    } catch (err) {
      setActionError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <Link to="/playlists" className="mb-4 inline-flex items-center gap-1 text-sm text-muted">
        <span aria-hidden="true">‹</span> Playlists
      </Link>

      {renaming ? (
        <div className="mb-4 flex gap-2">
          <input
            autoFocus
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            className="flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-primary"
          />
          <button onClick={() => void saveRename()} className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-slate-950">
            Save
          </button>
        </div>
      ) : (
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-primary">
            {playlist.is_reserved && <span aria-hidden="true">▶️ </span>}
            {playlist.name}
          </h1>
          {!playlist.is_reserved && (
            <div className="flex gap-3 text-xs">
              <button onClick={() => setRenaming(true)} className="text-muted underline">
                Rename
              </button>
              <button onClick={() => void handleDelete()} className="text-red-400 underline">
                Delete
              </button>
            </div>
          )}
        </div>
      )}

      {actionError && <p className="mb-3 text-xs text-red-400">{actionError}</p>}

      {playlist.items.length === 0 ? (
        <p className="px-2 text-center text-sm text-subtle">
          Nothing here yet — add books from a book's page.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {playlist.items.map((item, index) => {
            const book = byBookId.get(item.book_id)
            return (
              <li key={item.id} className="flex items-center gap-3 px-3 py-3">
                {book ? (
                  <>
                    <Link to={`/book/${book.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="w-12 shrink-0">
                        <CoverArt title={book.title} coverUrl={book.coverThumbUrl} />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-primary">{book.title}</p>
                        <p className="truncate text-xs text-muted">{book.author}</p>
                        <p className="text-xs text-subtle">{formatDuration(book.totalDuration)}</p>
                      </div>
                    </Link>
                  </>
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-subtle">This book is no longer in your library</p>
                  </div>
                )}
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <button
                    onClick={() => void move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move up"
                    className="text-muted disabled:opacity-20"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => void move(index, 1)}
                    disabled={index === playlist.items.length - 1}
                    aria-label="Move down"
                    className="text-muted disabled:opacity-20"
                  >
                    ▼
                  </button>
                </div>
                <button onClick={() => void remove(item)} aria-label="Remove" className="shrink-0 text-red-400">
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
