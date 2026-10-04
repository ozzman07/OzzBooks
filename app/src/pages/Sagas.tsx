import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { fetchSagas } from '../api/client'

export function Sagas() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const result = useAsync(() => fetchSagas(), [])

  // No create-saga API call — a saga isn't a persisted thing until it has
  // at least one series (see series_sagas' own schema comment). This just
  // navigates to a not-yet-existing saga's page; fetchSaga there returns
  // an empty series list rather than 404ing, and "+ Add a series" is what
  // actually creates the first row.
  function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    navigate(`/sagas/${encodeURIComponent(newName.trim())}`)
  }

  if (result.status === 'loading') {
    return <p className="px-4 pt-24 text-center text-muted">Loading…</p>
  }
  if (result.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 px-6 pt-24 text-center text-muted">
        <p className="text-lg text-primary">Can't reach your sagas right now</p>
        <button
          onClick={result.retry}
          className="mt-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-primary">Sagas</h1>
      <p className="mb-4 text-xs text-subtle">
        An overarching collection of series with its own reading order — e.g. Sanderson's Cosmere, or Feist's
        Midkemia saga.
      </p>

      {result.data.length > 0 ? (
        <ul className="mb-4 divide-y divide-border rounded-lg border border-border">
          {result.data.map((s) => (
            <li key={s.saga_name}>
              <Link to={`/sagas/${encodeURIComponent(s.saga_name)}`} className="block px-4 py-3">
                <p className="text-sm text-primary">{s.saga_name}</p>
                <p className="text-xs text-muted">{s.series_count} series</p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 px-2 text-center text-sm text-subtle">No sagas yet — create one below.</p>
      )}

      {creating ? (
        <form onSubmit={handleCreate} className="flex gap-2">
          <input
            autoFocus
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Saga name"
            className="flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-primary placeholder:text-subtle"
          />
          <button type="submit" className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-slate-950">
            Create
          </button>
        </form>
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="w-full rounded-lg border border-border-strong py-2 text-sm text-secondary"
        >
          + New saga
        </button>
      )}
    </div>
  )
}
