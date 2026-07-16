import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchSourceIssues,
  fetchScanStatus,
  scanSource,
  type ApiScanIssue,
  type ApiScanState,
  type ApiSource,
} from '../api/client'

const POLL_INTERVAL_MS = 5000

function formatWhen(iso: string | null): string {
  if (!iso) return 'Never scanned'
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
  return `Last scanned ${date.toLocaleString()}`
}

function formatStarted(iso: string): string {
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
  return date.toLocaleTimeString()
}

export function SourceStatusCard({ source, onRescanned }: { source: ApiSource; onRescanned: () => void }) {
  const [scanState, setScanState] = useState<ApiScanState>({ status: 'idle' })
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ApiScanIssue[] | null>(null)
  const [issuesLoading, setIssuesLoading] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scanning = scanState.status === 'running'
  const failedCount = source.last_scan_failed ?? 0

  const poll = useCallback(async () => {
    const state = await fetchScanStatus(source.id).catch((): ApiScanState => ({ status: 'idle' }))
    setScanState(state)
    if (state.status === 'running') {
      pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    } else if (state.status === 'completed') {
      setIssues(null) // stale until re-opened; the list may have changed
      onRescanned()
    }
  }, [source.id, onRescanned])

  useEffect(() => {
    // A scan can run for well over an hour and isn't tied to any one
    // request/tab — check on mount (and whenever this card remounts, e.g.
    // navigating back into Settings) rather than assuming idle, so an
    // in-progress scan started earlier still shows correctly.
    void poll()
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  async function toggleIssues() {
    if (issues) {
      setIssues(null)
      return
    }
    setIssuesLoading(true)
    try {
      setIssues(await fetchSourceIssues(source.id))
    } finally {
      setIssuesLoading(false)
    }
  }

  async function rescan() {
    setTriggerError(null)
    try {
      const state = await scanSource(source.id)
      setScanState(state)
      if (state.status === 'running') {
        pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
      }
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mb-3 rounded border border-slate-800 p-3 last:mb-0">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-slate-200">{source.label}</p>
          <p className="text-xs text-slate-500">{source.path_scope}</p>
        </div>
        <button
          onClick={() => void rescan()}
          disabled={scanning}
          className="shrink-0 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50"
        >
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </div>

      {scanState.status === 'running' && (
        <p className="mt-2 text-xs text-amber-400">Started {formatStarted(scanState.startedAt)} — this can take a while on a large library.</p>
      )}

      <p className="mt-2 text-xs text-slate-400">{formatWhen(source.last_scanned_at)}</p>
      <p className="text-xs text-slate-400">
        {source.book_count} book{source.book_count === 1 ? '' : 's'} indexed
        {source.missing_count > 0 && `, ${source.missing_count} missing`}
      </p>

      {source.last_scanned_at && (
        <p className="text-xs text-slate-500">
          Last scan: {source.last_scan_found} found, {source.last_scan_created} new, {source.last_scan_updated}{' '}
          updated
          {failedCount > 0 && `, ${failedCount} failed`}
          {(source.last_scan_skipped_duplicates ?? 0) > 0 && `, ${source.last_scan_skipped_duplicates} duplicates skipped`}
        </p>
      )}

      {scanState.status === 'failed' && (
        <p className="mt-2 text-xs text-red-400">Scan failed: {scanState.error}</p>
      )}
      {triggerError && <p className="mt-2 text-xs text-red-400">{triggerError}</p>}

      {failedCount > 0 && (
        <div className="mt-2">
          <button onClick={() => void toggleIssues()} className="text-xs text-amber-400 underline">
            {issuesLoading ? 'Loading…' : issues ? 'Hide issues' : `Show ${failedCount} issue${failedCount === 1 ? '' : 's'}`}
          </button>
          {issues && (
            <ul className="mt-2 space-y-2 border-t border-slate-800 pt-2">
              {issues.map((issue) => (
                <li key={issue.id} className="text-xs">
                  <p className="break-all text-slate-300">{issue.file_path}</p>
                  <p className="break-all text-slate-500">{issue.error}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
