import { enrichBooks, type EnrichmentResult } from './enrichBooks.js'

export type EnrichmentState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string }
  | { status: 'completed'; result: EnrichmentResult; finishedAt: string }
  | { status: 'failed'; error: string; finishedAt: string }

// In-memory only, library-wide (not keyed by source — enrichment spans
// all sources) — mirrors scanStatus.ts's shape exactly, kept as a
// separate small tracker rather than forced into that one since scans
// are per-source and this isn't.
let enrichmentState: EnrichmentState = { status: 'idle' }

export function getEnrichmentState(): EnrichmentState {
  return enrichmentState
}

/**
 * Starts an enrichment pass in the background (if one isn't already
 * running) and returns immediately — a real pass is rate-limited to
 * ~1 request/second against Open Library (see openLibrary.ts) and can
 * run for minutes to tens of minutes depending on how many books are
 * missing genre/cover data, so this uses the same fire-and-forget +
 * poll pattern as scanStatus.ts rather than blocking the triggering
 * request.
 */
export function startEnrichment(): EnrichmentState {
  if (enrichmentState.status === 'running') return enrichmentState

  const state: EnrichmentState = { status: 'running', startedAt: new Date().toISOString() }
  enrichmentState = state

  enrichBooks()
    .then((result) => {
      enrichmentState = { status: 'completed', result, finishedAt: new Date().toISOString() }
    })
    .catch((err) => {
      enrichmentState = { status: 'failed', error: String(err), finishedAt: new Date().toISOString() }
    })

  return state
}
