import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useAsync } from '../hooks/useAsync'
import { fetchPlaylists, createPlaylist, findUpNext, CloudApiError, type Playlist } from '../api/cloudClient'

export function Playlists() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const result = useAsync(async () => {
    if (!auth.token) return []
    return fetchPlaylists(auth.token)
  }, [auth.token])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!auth.token || !newName.trim()) return
    setCreateError(null)
    try {
      const playlist = await createPlaylist(auth.token, newName.trim())
      navigate(`/playlists/${playlist.id}`)
    } catch (err) {
      setCreateError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
    }
  }

  if (result.status === 'loading') {
    return <p className="px-4 pt-24 text-center text-slate-400">Loading…</p>
  }
  if (result.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 px-6 pt-24 text-center text-slate-400">
        <p className="text-lg text-slate-200">Can't reach your playlists right now</p>
        <p className="text-sm">The cloud service might be waking up. This usually resolves itself in a minute.</p>
        <button
          onClick={result.retry}
          className="mt-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950"
        >
          Retry
        </button>
      </div>
    )
  }

  const upNext = findUpNext(result.data)
  const named = result.data.filter((p) => !p.is_reserved)

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-slate-50">Playlists</h1>

      {upNext && (
        <Link
          to={`/playlists/${upNext.id}`}
          className="mb-4 block rounded-lg border border-amber-400/50 bg-amber-400/10 p-4"
        >
          <p className="text-sm font-medium text-amber-400">▶️ Up Next</p>
          <p className="mt-1 text-xs text-slate-400">Your queue — books added here play next.</p>
        </Link>
      )}

      {named.length > 0 && (
        <ul className="mb-4 divide-y divide-slate-800 rounded-lg border border-slate-800">
          {named.map((p: Playlist) => (
            <li key={p.id}>
              <Link to={`/playlists/${p.id}`} className="block px-4 py-3 text-sm text-slate-200">
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {named.length === 0 && (
        <p className="mb-4 px-2 text-center text-sm text-slate-500">
          No playlists yet — create one below, or add books from a book's page.
        </p>
      )}

      {creating ? (
        <form onSubmit={handleCreate} className="flex gap-2">
          <input
            autoFocus
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Playlist name"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
          />
          <button type="submit" className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-slate-950">
            Create
          </button>
        </form>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="w-full rounded-lg border border-slate-700 py-2 text-sm text-slate-300"
        >
          + New playlist
        </button>
      )}
      {createError && <p className="mt-2 text-xs text-red-400">{createError}</p>}
    </div>
  )
}
