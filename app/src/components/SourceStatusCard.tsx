import { useState } from 'react'
import { fetchSourceIssues, scanSource, type ApiScanIssue, type ApiSource } from '../api/client'

function formatWhen(iso: string | null): string {
  if (!iso) return 'Never scanned'
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
  return `Last scanned ${date.toLocaleString()}`
}

export function SourceStatusCard({ source, onRescanned }: { source: ApiSource; onRescanned: () => void }) {
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ApiScanIssue[] | null>(null)
  const [issuesLoading, setIssuesLoading] = useState(false)

  const failedCount = source.last_scan_failed ?? 0

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
    setScanning(true)
    setScanError(null)
    try {
      await scanSource(source.id)
      setIssues(null) // stale until re-opened; the list may have changed
      onRescanned()
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
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

      {scanError && <p className="mt-2 text-xs text-red-400">Scan failed: {scanError}</p>}

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
