import type { SourceRow } from '../types.js'
import { scanSource, type ScanResult } from './scan.js'

export type ScanState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string }
  | { status: 'completed'; result: ScanResult; finishedAt: string }
  | { status: 'failed'; error: string; finishedAt: string }

// In-memory only, per source id — a scan in progress doesn't survive a
// server restart anyway (the scan itself dies with the process), so
// there's nothing to persist. Fine for a single-instance deployment.
const scanStates = new Map<string, ScanState>()

export function getScanState(sourceId: string): ScanState {
  return scanStates.get(sourceId) ?? { status: 'idle' }
}

/**
 * Starts a scan in the background (if one isn't already running for this
 * source) and returns immediately — for triggering from a mobile client,
 * where a real scan (minutes to over an hour on a large library) would
 * otherwise die the moment the request's tab backgrounds mid-flight. The
 * scan itself is unaffected either way since it isn't tied to the response
 * connection; this just makes the *client's* view of progress survive
 * that. Poll getScanState() instead of awaiting this.
 */
export function startScan(source: SourceRow): ScanState {
  const current = scanStates.get(source.id)
  if (current?.status === 'running') return current

  const state: ScanState = { status: 'running', startedAt: new Date().toISOString() }
  scanStates.set(source.id, state)

  scanSource(source)
    .then((result) => {
      scanStates.set(source.id, { status: 'completed', result, finishedAt: new Date().toISOString() })
    })
    .catch((err) => {
      scanStates.set(source.id, { status: 'failed', error: String(err), finishedAt: new Date().toISOString() })
    })

  return state
}
