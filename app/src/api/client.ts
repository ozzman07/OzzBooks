const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''
const API_TOKEN = import.meta.env.VITE_API_TOKEN ?? ''

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${API_TOKEN}`,
        ...init?.headers,
      },
    })
  } catch (err) {
    // Network failure (server unreachable, e.g. Mac mini asleep/restarting) —
    // distinct from an HTTP error status, callers use this to show the
    // "can't reach your library" retry UI from Claude.md rather than a crash.
    throw new ApiError(`Network error reaching API: ${String(err)}`, 0)
  }

  if (!res.ok) {
    throw new ApiError(`API request failed: ${res.status} ${res.statusText}`, res.status)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// Media elements (<audio>, <img>) can't set an Authorization header, so
// these use a `?token=` query param instead — see server/src/api/auth.ts.
function mediaUrl(path: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${API_BASE_URL}${path}${separator}token=${encodeURIComponent(API_TOKEN)}`
}

export interface ApiChapter {
  id: string
  book_id: string
  idx: number
  title: string
  start_time: number
  duration: number
  file_path: string
}

export interface ApiBook {
  id: string
  source_id: string
  file_path: string
  format: 'm4b' | 'mp3_folder'
  title: string
  author: string | null
  series_name: string | null
  series_number: number | null
  status: 'active' | 'missing'
  artwork_thumb_path: string | null
  artwork_full_path: string | null
  volume_normalization_gain: number | null
  content_hash: string | null
  created_at: string
  updated_at: string
}

// List endpoint aggregates total_duration server-side (SUM over chapters);
// the detail endpoint returns the chapters themselves instead. Also
// includes last_chapter_id, which the library view uses (together with
// synced progress) to derive a lightweight "finished" status without
// fetching every book's full chapter list.
export interface ApiBookListItem extends ApiBook {
  total_duration: number
  last_chapter_id: string | null
}

export interface ApiBookDetail extends ApiBook {
  chapters: ApiChapter[]
  source_label: string
  source_type: string
}

export interface ApiSource {
  id: string
  type: string
  label: string
  path_scope: string
  created_at: string
  last_scanned_at: string | null
  last_scan_found: number | null
  last_scan_created: number | null
  last_scan_updated: number | null
  last_scan_failed: number | null
  last_scan_skipped_duplicates: number | null
  credentials_status: 'ok' | 'needs_reconnect'
  credentials_account_label: string | null
  book_count: number
  missing_count: number
}

export interface ApiScanIssue {
  id: string
  source_id: string
  file_path: string
  error: string
  occurred_at: string
}

export interface ApiScanResult {
  found: number
  created: number
  updated: number
  markedMissing: number
  skippedDuplicates: number
  failed: number
}

// A scan is fire-and-forget on the server (it can run for well over an
// hour on a large library) — triggering it returns a 'running' state
// immediately rather than the result, and fetchScanStatus is polled until
// it flips to 'completed'/'failed'. This survives a mobile tab
// backgrounding mid-scan, unlike waiting on one long request.
export type ApiScanState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string }
  | { status: 'completed'; result: ApiScanResult; finishedAt: string }
  | { status: 'failed'; error: string; finishedAt: string }

export function fetchSources(): Promise<ApiSource[]> {
  return apiFetch<ApiSource[]>('/api/sources')
}

// Full-page navigation, not fetch() — this is an OAuth consent flow, the
// browser has to actually go to Google's consent screen and back, not
// receive JSON. Passing sourceId re-authorizes an existing source in
// place (used for "Reconnect" after credentials_status flips to
// needs_reconnect) rather than creating a duplicate.
export function connectGoogleDrive(label?: string, sourceId?: string): void {
  const params = new URLSearchParams()
  if (label) params.set('label', label)
  if (sourceId) params.set('sourceId', sourceId)
  const query = params.toString()
  window.location.href = `${API_BASE_URL}/api/sources/oauth/google/start${query ? `?${query}` : ''}`
}

export function fetchSourceIssues(sourceId: string): Promise<ApiScanIssue[]> {
  return apiFetch<ApiScanIssue[]>(`/api/sources/${sourceId}/issues`)
}

// Also covers "scan for new books" — a scan always walks the whole source
// tree fresh, so the same request both retries previously-failed files and
// picks up anything new, with no separate "new only" mode needed.
export function scanSource(sourceId: string): Promise<ApiScanState> {
  return apiFetch<ApiScanState>(`/api/sources/${sourceId}/scan`, { method: 'POST' })
}

export function fetchScanStatus(sourceId: string): Promise<ApiScanState> {
  return apiFetch<ApiScanState>(`/api/sources/${sourceId}/scan-status`)
}

// Reuses the same needs_reconnect mechanism as an automatically-revoked
// grant — the returned source still exists, just with credentials cleared
// and its books marked missing until reconnected.
export function disconnectSource(sourceId: string): Promise<ApiSource> {
  return apiFetch<ApiSource>(`/api/sources/${sourceId}/disconnect`, { method: 'POST' })
}

// App-wide server settings (this server's own SQLite DB) — distinct from
// cloudClient.ts's fetchSettings/putSettings, which are per-user
// preferences (storage budget, etc.) stored in the separate cloud/Postgres
// account service.
export interface ApiAppSettings {
  nightly_rescan_enabled: boolean
  nightly_rescan_time: string
  nightly_rescan_last_run_date: string | null
}

export function fetchAppSettings(): Promise<ApiAppSettings> {
  return apiFetch<ApiAppSettings>('/api/settings')
}

export function updateAppSettings(patch: {
  nightlyRescanEnabled?: boolean
  nightlyRescanTime?: string
}): Promise<ApiAppSettings> {
  return apiFetch<ApiAppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) })
}

export interface ApiEnrichmentResult {
  attempted: number
  genreUpdated: number
  coverUpdated: number
  skipped: number
  failed: number
}

// Same fire-and-forget shape as ApiScanState, but library-wide rather than
// per-source — see server/src/ingestion/enrichment/enrichmentStatus.ts.
export type ApiEnrichmentState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string }
  | { status: 'completed'; result: ApiEnrichmentResult; finishedAt: string }
  | { status: 'failed'; error: string; finishedAt: string }

export function startEnrichment(): Promise<ApiEnrichmentState> {
  return apiFetch<ApiEnrichmentState>('/api/enrichment/start', { method: 'POST' })
}

export function fetchEnrichmentStatus(): Promise<ApiEnrichmentState> {
  return apiFetch<ApiEnrichmentState>('/api/enrichment/status')
}

export function fetchBooks(): Promise<ApiBookListItem[]> {
  return apiFetch<ApiBookListItem[]>('/api/books')
}

export function fetchBook(id: string): Promise<ApiBookDetail> {
  return apiFetch<ApiBookDetail>(`/api/books/${id}`)
}

export function updateBook(
  id: string,
  patch: { seriesName?: string | null; seriesNumber?: number | null },
): Promise<ApiBookDetail> {
  return apiFetch<ApiBookDetail>(`/api/books/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export interface ApiSeriesNumberBackfillResult {
  attempted: number
  updated: number
}

// Synchronous (no job-polling type needed) — pure local string matching
// against data already in the DB, resolves in well under a second even
// against the whole library.
export function backfillSeriesNumbers(): Promise<ApiSeriesNumberBackfillResult> {
  return apiFetch<ApiSeriesNumberBackfillResult>('/api/books/backfill-series-numbers', { method: 'POST' })
}

// Relinking a missing book: ranked suggestions first, manual folder browse
// as a fallback, then a parse-only preview (old-vs-new duration/chapter
// count sanity check) before the confirm step actually writes anything.
export interface ApiRelinkCandidate {
  path: string // relative to the source's path_scope
  format: 'm4b' | 'mp3_folder'
}

export interface ApiBrowseEntry {
  name: string
  path: string // relative to the source's path_scope
  type: 'folder' | 'file'
  selectable: boolean
  format?: 'm4b' | 'mp3_folder'
}

export interface ApiRelinkPreview {
  newTitle: string
  newDurationSeconds: number
  newChapterCount: number
  oldDurationSeconds: number
  oldChapterCount: number
  mismatchWarning: boolean
}

export function fetchRelinkCandidates(bookId: string): Promise<ApiRelinkCandidate[]> {
  return apiFetch<ApiRelinkCandidate[]>(`/api/books/${bookId}/relink-candidates`)
}

export function browseSource(sourceId: string, relativePath: string): Promise<ApiBrowseEntry[]> {
  return apiFetch<ApiBrowseEntry[]>(`/api/sources/${sourceId}/browse?path=${encodeURIComponent(relativePath)}`)
}

export function previewRelink(
  bookId: string,
  relativePath: string,
  format: 'm4b' | 'mp3_folder',
): Promise<ApiRelinkPreview> {
  return apiFetch<ApiRelinkPreview>(`/api/books/${bookId}/relink/preview`, {
    method: 'POST',
    body: JSON.stringify({ path: relativePath, format }),
  })
}

export function confirmRelink(
  bookId: string,
  relativePath: string,
  format: 'm4b' | 'mp3_folder',
): Promise<{ bookId: string }> {
  return apiFetch<{ bookId: string }>(`/api/books/${bookId}/relink/confirm`, {
    method: 'POST',
    body: JSON.stringify({ path: relativePath, format }),
  })
}

export function streamUrl(chapterId: string): string {
  return mediaUrl(`/api/chapters/${chapterId}/stream`)
}

export function artworkUrl(bookId: string, size: 'thumb' | 'full'): string {
  return mediaUrl(`/api/books/${bookId}/artwork/${size}`)
}
