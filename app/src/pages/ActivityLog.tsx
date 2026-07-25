import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAsync } from '../hooks/useAsync'
import { fetchActivityLog, markActivityLogViewed, type ActivityAction, type ApiActivityLogEntry } from '../api/client'

function formatWhen(iso: string): string {
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
  return date.toLocaleString()
}

const ACTION_LABELS: Record<ActivityAction, { label: string; className: string }> = {
  created: { label: 'Added', className: 'bg-success-soft text-success-soft-text' },
  relinked: { label: 'Relinked', className: 'bg-warning-soft text-warning-soft-text' },
  missing: { label: 'Missing', className: 'bg-danger-soft text-danger-soft-text' },
  removed: { label: 'Removed', className: 'bg-danger-soft text-danger-soft-text' },
  metadata_updated: { label: 'Metadata', className: 'bg-surface text-subtle' },
  series_updated: { label: 'Series edited', className: 'bg-surface text-subtle' },
}

export function ActivityLog() {
  const result = useAsync(() => fetchActivityLog(), [])

  // Fire-and-forget — resets the "N new" count on Settings the moment this
  // page is opened, same as any unread-count pattern. Not awaited: nothing
  // on this page depends on it completing.
  useEffect(() => {
    void markActivityLogViewed()
  }, [])

  return (
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-primary">Activity Log</h1>
        <Link to="/settings" className="text-xs text-muted">
          ← Settings
        </Link>
      </div>

      {result.status === 'loading' && <p className="text-center text-muted">Loading…</p>}

      {result.status === 'error' && (
        <div className="flex flex-col items-center gap-3 pt-12 text-center text-muted">
          <p className="text-sm">Couldn't load the activity log.</p>
          <button onClick={result.retry} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950">
            Retry
          </button>
        </div>
      )}

      {result.status === 'success' && result.data.length === 0 && (
        <p className="pt-12 text-center text-sm text-subtle">Nothing logged yet.</p>
      )}

      {result.status === 'success' && result.data.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {result.data.map((entry: ApiActivityLogEntry) => {
            const actionMeta = ACTION_LABELS[entry.action]
            return (
              <li key={entry.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-primary">{entry.title}</p>
                    {entry.author && <p className="truncate text-xs text-muted">{entry.author}</p>}
                  </div>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${actionMeta.className}`}>
                    {actionMeta.label}
                  </span>
                </div>
                {entry.detail && <p className="mt-1 text-xs text-subtle">{entry.detail}</p>}
                <p className="mt-1 text-[11px] text-subtle">{formatWhen(entry.created_at)}</p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
