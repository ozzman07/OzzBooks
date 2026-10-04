import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { fetchPlaylists, createPlaylist, addToPlaylist, findUpNext, CloudApiError, type Playlist } from '../api/cloudClient'
import type { Book } from '../types'

/**
 * Bulk version of BookDetail.tsx's AddToPlaylist — adds every book in
 * `books` (already ordered/deduped by the caller, see
 * orderedSeriesBooks/orderedSagaBooks in bookOrganize.ts) to a playlist in
 * one action. Shared by the series view and Saga Detail rather than
 * duplicated, since the only real difference between "add a series" and
 * "add a saga" is which book list the caller passes in.
 *
 * Adds sequentially, not Promise.all — the server assigns each new item's
 * position as "current max + 1" per request (see
 * cloud/src/api/routes/playlists.ts), not as an atomic batch, so firing
 * these in parallel could let two inserts read the same max and collide
 * on position, scrambling the order.
 *
 * Supports creating a brand-new playlist inline, not just picking an
 * existing one — e.g. to rebuild a playlist under a new or suffixed name
 * (so it can be reviewed before the old one is deleted) rather than
 * needing a trip to the Playlists page first. Deliberately does NOT offer
 * a "replace/clear this playlist first" option: that pairs a destructive
 * action with what should always be a safe "add" control, and
 * Playlist Detail's own Delete button (which already confirms) plus a
 * fresh create-and-add here does the same job without that risk — Jim's
 * own call.
 */
export function AddBooksToPlaylist({ books, label }: { books: Book[]; label: string }) {
  const auth = useAuth()
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  // The playlist id currently being added to ('new' for the inline-create
  // case) — disables every other action mid-flight rather than tracking a
  // single boolean, so a slow add to one playlist can't be raced by a tap
  // on a different one.
  const [adding, setAdding] = useState<string | null>(null)
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

  async function addAllTo(playlist: Playlist) {
    if (!auth.token || books.length === 0) return
    const token = auth.token
    setError(null)
    setFeedback(null)
    setAdding(playlist.id)
    try {
      for (const book of books) {
        await addToPlaylist(token, playlist.id, book.id)
      }
      setFeedback(`Added ${books.length} book${books.length === 1 ? '' : 's'} to ${playlist.name}`)
      setShowPicker(false)
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
    } finally {
      setAdding(null)
    }
  }

  async function handleAddToUpNext() {
    const loaded = await ensurePlaylistsLoaded()
    const upNext = loaded && findUpNext(loaded)
    if (upNext) void addAllTo(upNext)
  }

  async function createAndAddTo(name: string) {
    const trimmed = name.trim()
    if (!auth.token || !trimmed) return
    setError(null)
    setAdding('new')
    try {
      const playlist = await createPlaylist(auth.token, trimmed)
      setPlaylists((prev) => (prev ? [...prev, playlist] : prev))
      await addAllTo(playlist)
      setNewPlaylistName('')
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
      setAdding(null)
    }
  }

  async function togglePicker() {
    if (!showPicker) await ensurePlaylistsLoaded()
    setShowPicker((v) => !v)
  }

  if (books.length === 0) return null

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleAddToUpNext()}
          disabled={adding !== null}
          className="flex-1 rounded-lg border border-border-strong py-2 text-sm text-primary disabled:opacity-50"
        >
          + Add {label} to Up Next
        </button>
        <button
          onClick={() => void togglePicker()}
          className="flex-1 rounded-lg border border-border-strong py-2 text-sm text-primary"
        >
          Add {label} to a playlist…
        </button>
      </div>

      {showPicker && (
        <div className="mt-2 rounded-lg border border-border-strong bg-surface p-2 shadow-lg">
          {playlists && playlists.length > 0 && (
            <div className="mb-2 space-y-1">
              {playlists.map((p) => (
                <button
                  key={p.id}
                  onClick={() => void addAllTo(p)}
                  disabled={adding !== null}
                  className="block w-full rounded px-3 py-2 text-left text-sm text-primary hover:bg-border disabled:opacity-50"
                >
                  {p.is_reserved ? '▶️ ' : ''}
                  {p.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              placeholder="New playlist name"
              className="flex-1 rounded border border-border-strong bg-background px-2 py-1 text-xs text-primary placeholder:text-subtle"
            />
            <button
              onClick={() => void createAndAddTo(newPlaylistName)}
              disabled={adding !== null || !newPlaylistName.trim()}
              className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-secondary disabled:opacity-40"
            >
              {adding === 'new' ? 'Creating…' : 'Create & add'}
            </button>
          </div>
        </div>
      )}

      {feedback && <p className="mt-1 text-center text-xs text-emerald-400">{feedback}</p>}
      {error && <p className="mt-1 text-center text-xs text-red-400">{error}</p>}
    </div>
  )
}
