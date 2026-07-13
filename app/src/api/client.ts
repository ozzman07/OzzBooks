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
// the detail endpoint returns the chapters themselves instead.
export interface ApiBookListItem extends ApiBook {
  total_duration: number
}

export interface ApiBookDetail extends ApiBook {
  chapters: ApiChapter[]
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

export function fetchSources(): Promise<ApiSource[]> {
  return apiFetch<ApiSource[]>('/api/sources')
}

export function fetchSourceIssues(sourceId: string): Promise<ApiScanIssue[]> {
  return apiFetch<ApiScanIssue[]>(`/api/sources/${sourceId}/issues`)
}

// Also covers "scan for new books" — a scan always walks the whole source
// tree fresh, so the same request both retries previously-failed files and
// picks up anything new, with no separate "new only" mode needed.
export function scanSource(sourceId: string): Promise<ApiScanResult> {
  return apiFetch<ApiScanResult>(`/api/sources/${sourceId}/scan`, { method: 'POST' })
}

export function fetchBooks(): Promise<ApiBookListItem[]> {
  return apiFetch<ApiBookListItem[]>('/api/books')
}

export function fetchBook(id: string): Promise<ApiBookDetail> {
  return apiFetch<ApiBookDetail>(`/api/books/${id}`)
}

export function streamUrl(chapterId: string): string {
  return mediaUrl(`/api/chapters/${chapterId}/stream`)
}

export function artworkUrl(bookId: string, size: 'thumb' | 'full'): string {
  return mediaUrl(`/api/books/${bookId}/artwork/${size}`)
}
