/**
 * Shared retry/backoff and concurrency limiting for outbound HTTP requests
 * against a remote source's API (Google Drive today — any future
 * RemoteProvider hits the same underlying quota concerns). Built after a
 * real rescan produced ~86 failures and a large number of books marked
 * missing, traced to bare 403s from Drive's Range-GET and metadata
 * endpoints (see the scan_issues rows from that run) with no captured
 * response body to say *why*, and no backoff to survive a transient
 * rate-limit.
 */

/** Carries the HTTP status and response body text so a scan_issues row
 * shows Google's actual quota-exceeded reason instead of a bare "403". */
export class DriveHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'DriveHttpError'
  }
}

// Google documents 403 (userRateLimitExceeded/rateLimitExceeded) and 429 as
// the statuses to retry with truncated exponential backoff; 5xx are
// transient server errors worth the same treatment. Anything else (404,
// 401, a network error) retrying would just burn more quota for no reason.
function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500
}

const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1000

function backoffDelayMs(attempt: number): number {
  const exponential = BASE_DELAY_MS * 2 ** attempt
  return exponential + Math.random() * exponential * 0.5
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retries a single Drive HTTP call with truncated exponential backoff when
 * it fails with a retryable status. Any other failure (auth, not-found,
 * a network error, or the final attempt) is rethrown as-is.
 */
export async function withDriveRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
      const status = err instanceof DriveHttpError ? err.status : undefined
      if (status === undefined || !isRetryableStatus(status) || i === MAX_ATTEMPTS - 1) throw err
      const delay = backoffDelayMs(i)
      console.warn(
        `Drive request retry ${i + 1}/${MAX_ATTEMPTS} for ${label} after status ${status}, waiting ${Math.round(delay)}ms`,
      )
      await sleep(delay)
    }
  }
  throw lastErr
}

// Caps how many Drive HTTP operations run at once across an entire scan —
// API calls, media Range-GETs, and ffprobe's own remote reads alike — so a
// single large chapter-rip group (the Going Postal incident: 19 files in
// one folder, each needing several requests) can't burst far past Drive's
// per-user rate limit the way an unbounded Promise.all did before.
const MAX_CONCURRENT_DRIVE_REQUESTS = 4
let activeCount = 0
const waitQueue: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT_DRIVE_REQUESTS) {
    activeCount++
    return Promise.resolve()
  }
  return new Promise((resolve) => waitQueue.push(resolve))
}

function releaseSlot(): void {
  activeCount--
  const next = waitQueue.shift()
  if (next) {
    activeCount++
    next()
  }
}

export async function withDriveLimit<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot()
  try {
    return await fn()
  } finally {
    releaseSlot()
  }
}
