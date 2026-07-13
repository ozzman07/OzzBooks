import type { Position } from '../types'

const CLOUD_BASE_URL = import.meta.env.VITE_CLOUD_API_BASE_URL ?? ''

export class CloudApiError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'CloudApiError'
    this.status = status
    this.body = body
  }
}

async function cloudFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${CLOUD_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch (err) {
    throw new CloudApiError(`Network error reaching cloud service: ${String(err)}`, 0, null)
  }

  const body = res.status === 204 ? undefined : await res.json().catch(() => undefined)
  if (!res.ok) {
    throw new CloudApiError((body as { error?: string })?.error ?? res.statusText, res.status, body)
  }
  return body as T
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

export interface AuthUser {
  id: string
  email: string
}

export interface AuthResponse {
  token: string
  user: AuthUser
}

export function signup(email: string, password: string): Promise<AuthResponse> {
  return cloudFetch<AuthResponse>('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) })
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return cloudFetch<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
}

export function fetchMe(token: string): Promise<AuthUser> {
  return cloudFetch<AuthUser>('/auth/me', { headers: authHeaders(token) })
}

export interface ProgressEntry {
  user_id: string
  book_id: string
  position: Position
  chapter_id: string | null
  updated_at: string
}

export function fetchAllProgress(token: string): Promise<ProgressEntry[]> {
  return cloudFetch<ProgressEntry[]>('/sync/progress', { headers: authHeaders(token) })
}

export async function fetchBookProgress(token: string, bookId: string): Promise<ProgressEntry | null> {
  try {
    return await cloudFetch<ProgressEntry>(`/sync/progress/${bookId}`, { headers: authHeaders(token) })
  } catch (err) {
    if (err instanceof CloudApiError && err.status === 404) return null
    throw err
  }
}

export function putProgress(
  token: string,
  bookId: string,
  data: { position: Position; chapterId: string; updatedAt: string },
): Promise<ProgressEntry> {
  return cloudFetch<ProgressEntry>(`/sync/progress/${bookId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  }).catch((err) => {
    // 409 means a newer write from another device already won — that's
    // not a failure, it's the conflict-resolution outcome. The response
    // body is still the current row, so surface it the same way a 200
    // would be rather than making callers special-case this.
    if (err instanceof CloudApiError && err.status === 409) {
      return err.body as ProgressEntry
    }
    throw err
  })
}

export interface UserSettings {
  user_id: string
  storage_budget_mb: number
  playback_speed: number
  skip_silence_enabled: boolean
}

export function fetchSettings(token: string): Promise<UserSettings> {
  return cloudFetch<UserSettings>('/sync/settings', { headers: authHeaders(token) })
}

export function putSettings(
  token: string,
  data: { storageBudgetMb?: number; playbackSpeed?: number; skipSilenceEnabled?: boolean },
): Promise<UserSettings> {
  return cloudFetch<UserSettings>('/sync/settings', {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(data),
  })
}
