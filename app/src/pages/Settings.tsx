import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useTheme, type ThemePreference } from '../theme/ThemeContext'
import {
  fetchBooks,
  fetchSources,
  connectGoogleDrive,
  startEnrichment,
  fetchEnrichmentStatus,
  fetchAppSettings,
  updateAppSettings,
  type ApiSource,
  type ApiEnrichmentState,
  type ApiAppSettings,
} from '../api/client'
import { fetchSettings, putSettings, CloudApiError } from '../api/cloudClient'
import { getAllCachedAudioFiles } from '../offline/audioFileStore'
import { deleteBookDownload } from '../offline/downloadManager'
import { SourceStatusCard } from '../components/SourceStatusCard'

const ENRICHMENT_POLL_INTERVAL_MS = 5000

// Library-wide, not per-source, so this lives alongside the per-source
// SourceStatusCards rather than as one of them — same fire-and-forget +
// poll pattern (fetchEnrichmentStatus mirrors fetchScanStatus exactly).
function MetadataEnrichmentCard() {
  const [state, setState] = useState<ApiEnrichmentState>({ status: 'idle' })
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const running = state.status === 'running'

  const poll = useCallback(async () => {
    const next = await fetchEnrichmentStatus().catch((): ApiEnrichmentState => ({ status: 'idle' }))
    setState(next)
    if (next.status === 'running') {
      pollTimer.current = setTimeout(() => void poll(), ENRICHMENT_POLL_INTERVAL_MS)
    }
  }, [])

  useEffect(() => {
    // A pass can run for tens of minutes and isn't tied to any one
    // request/tab — check on mount so a pass started earlier (or before
    // navigating away and back) still shows correctly.
    void poll()
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function start() {
    setTriggerError(null)
    try {
      const next = await startEnrichment()
      setState(next)
      if (next.status === 'running') {
        pollTimer.current = setTimeout(() => void poll(), ENRICHMENT_POLL_INTERVAL_MS)
      }
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mb-3 rounded border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-primary">Genre & cover backfill</p>
          <p className="text-xs text-subtle">
            Looks up missing genre and cover art from Open Library. Runs slowly (about one book a second) to stay
            respectful of their free API.
          </p>
        </div>
        <button
          onClick={() => void start()}
          disabled={running}
          className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-secondary disabled:opacity-50"
        >
          {running ? 'Running…' : 'Backfill'}
        </button>
      </div>

      {state.status === 'running' && (
        <p className="mt-2 text-xs text-amber-400">
          Started {new Date(state.startedAt).toLocaleTimeString()} — this can take a while.
        </p>
      )}
      {state.status === 'completed' && (
        <p className="mt-2 text-xs text-emerald-400">
          Done: {state.result.genreUpdated} genre{state.result.genreUpdated === 1 ? '' : 's'} added,{' '}
          {state.result.coverUpdated} cover{state.result.coverUpdated === 1 ? '' : 's'} added
          {state.result.skipped > 0 && `, ${state.result.skipped} skipped (no confident match)`}
          {state.result.failed > 0 && `, ${state.result.failed} failed`}.
        </p>
      )}
      {state.status === 'failed' && <p className="mt-2 text-xs text-red-400">Failed: {state.error}</p>}
      {triggerError && <p className="mt-2 text-xs text-red-400">{triggerError}</p>}
    </div>
  )
}

// Library-wide, global (not per-source, per the user's explicit choice) —
// lives alongside MetadataEnrichmentCard for the same reason. Save-on-change,
// no separate Save button, matching the Storage budget field's pattern.
function NightlyRescanCard() {
  const [settings, setSettings] = useState<ApiAppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchAppSettings()
      .then(setSettings)
      .catch(() => {})
  }, [])

  async function update(patch: { nightlyRescanEnabled?: boolean; nightlyRescanTime?: string }) {
    setError(null)
    try {
      setSettings(await updateAppSettings(patch))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!settings) return null

  return (
    <div className="mt-3 rounded border border-border p-3">
      <label className="flex items-center justify-between text-sm text-secondary">
        <span>Nightly reindex</span>
        <input
          type="checkbox"
          checked={settings.nightly_rescan_enabled}
          onChange={(e) => void update({ nightlyRescanEnabled: e.target.checked })}
          className="h-4 w-4"
        />
      </label>

      <label className="mt-2 flex items-center justify-between text-sm text-secondary">
        <span>Time</span>
        <input
          type="time"
          value={settings.nightly_rescan_time}
          disabled={!settings.nightly_rescan_enabled}
          onChange={(e) => void update({ nightlyRescanTime: e.target.value })}
          className="rounded border border-border-strong bg-surface px-2 py-1 text-primary disabled:opacity-50"
        />
      </label>

      <p className="mt-2 text-xs text-subtle">
        {settings.nightly_rescan_last_run_date ? `Last ran ${settings.nightly_rescan_last_run_date}` : 'Never run yet'}
      </p>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

function AppearanceCard() {
  const { preference, setPreference } = useTheme()
  return (
    <section className="rounded-lg border border-border p-4">
      <h2 className="mb-2 text-sm font-medium text-primary">Appearance</h2>
      <div className="flex overflow-hidden rounded-lg border border-border-strong text-sm">
        {APPEARANCE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setPreference(opt.value)}
            className={`flex-1 px-3 py-1.5 ${
              preference === opt.value ? 'bg-amber-400 text-slate-950' : 'bg-surface text-secondary'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </section>
  )
}

// No password-reset/change-of-email flow exists (no mail-sending infra in
// this project) — these two forms are the self-service alternative, each
// gated behind re-entering the current password.
function ChangePasswordForm() {
  const auth = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match")
      return
    }
    setSubmitting(true)
    try {
      await auth.changePassword(currentPassword, newPassword)
      setSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Change password</p>
      <input
        type="password"
        required
        placeholder="Current password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-primary placeholder:text-subtle"
      />
      <input
        type="password"
        required
        minLength={8}
        placeholder="New password (min 8 characters)"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-primary placeholder:text-subtle"
      />
      <input
        type="password"
        required
        placeholder="Confirm new password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-primary placeholder:text-subtle"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">Password changed.</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-lg border border-border-strong py-2 text-sm text-primary disabled:opacity-40"
      >
        {submitting ? 'Saving…' : 'Update password'}
      </button>
    </form>
  )
}

function ChangeEmailForm() {
  const auth = useAuth()
  const [newEmail, setNewEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setSubmitting(true)
    try {
      await auth.changeEmail(newEmail, currentPassword)
      setSuccess(true)
      setNewEmail('')
      setCurrentPassword('')
    } catch (err) {
      setError(err instanceof CloudApiError ? err.message : 'Could not reach the server')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Change email</p>
      <input
        type="email"
        required
        placeholder="New email"
        value={newEmail}
        onChange={(e) => setNewEmail(e.target.value)}
        className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-primary placeholder:text-subtle"
      />
      <input
        type="password"
        required
        placeholder="Current password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-primary placeholder:text-subtle"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">Email updated.</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-lg border border-border-strong py-2 text-sm text-primary disabled:opacity-40"
      >
        {submitting ? 'Saving…' : 'Update email'}
      </button>
    </form>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface DownloadedBook {
  bookId: string
  title: string
  bytes: number
}

export function Settings() {
  const auth = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [budgetMb, setBudgetMb] = useState<number | null>(null)
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)
  const [downloadedBooks, setDownloadedBooks] = useState<DownloadedBook[]>([])
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [sources, setSources] = useState<ApiSource[]>([])
  // Distinct from `sources.length === 0` — an empty array is ALSO the
  // initial state before the first fetch resolves, and "Connect Google
  // Drive" must stay hidden during that window too (not just once we know
  // a Drive source exists) — otherwise a tap in that brief gap starts a
  // fresh OAuth flow with no sourceId and creates a duplicate source +
  // Drive folder, exactly the bug this once already shipped with.
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  // Set by the OAuth callback's redirect (?connected=google_drive) — shown
  // once, then stripped from the URL so refreshing the page doesn't keep
  // re-showing it.
  const justConnected = searchParams.get('connected')

  const refreshSources = useCallback(async () => {
    setSources(await fetchSources().catch(() => []))
    setSourcesLoaded(true)
  }, [])

  const refreshDownloads = useCallback(async () => {
    const [cached, books] = await Promise.all([getAllCachedAudioFiles(), fetchBooks().catch(() => [])])
    const titleById = new Map(books.map((b) => [b.id, b.title]))
    const bytesByBook = new Map<string, number>()
    for (const entry of cached) {
      bytesByBook.set(entry.bookId, (bytesByBook.get(entry.bookId) ?? 0) + entry.sizeBytes)
    }
    setDownloadedBooks(
      [...bytesByBook.entries()].map(([bookId, bytes]) => ({
        bookId,
        title: titleById.get(bookId) ?? 'Unknown book',
        bytes,
      })),
    )
  }, [])

  useEffect(() => {
    if (justConnected) {
      setSearchParams((params) => {
        params.delete('connected')
        return params
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void refreshDownloads()
    void refreshSources()

    if (navigator.storage?.estimate) {
      navigator.storage.estimate().then((e) => setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 }))
    }
    // Requested each session to reduce eviction risk — best-effort, iOS
    // Safari may still decline.
    if (typeof navigator.storage?.persist === 'function') {
      navigator.storage.persisted().then(setPersisted)
    }

    if (auth.token) {
      fetchSettings(auth.token)
        .then((s) => setBudgetMb(s.storage_budget_mb))
        .catch(() => {})
    }
  }, [auth.token, refreshDownloads, refreshSources])

  async function requestPersistence() {
    if (typeof navigator.storage?.persist !== 'function') return
    const granted = await navigator.storage.persist()
    setPersisted(granted)
  }

  async function saveBudget() {
    if (!auth.token || budgetMb === null) return
    await putSettings(auth.token, { storageBudgetMb: budgetMb })
  }

  async function removeBookDownload(bookId: string) {
    await deleteBookDownload(bookId)
    await refreshDownloads()
  }

  const totalDownloadedBytes = downloadedBooks.reduce((sum, b) => sum + b.bytes, 0)

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-primary">Settings</h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:grid-flow-row-dense">
        <section className="rounded-lg border border-border p-4">
          <h2 className="mb-2 text-sm font-medium text-primary">Storage</h2>

          {estimate && (
            <p className="mb-2 text-xs text-muted">
              Device storage: {formatBytes(estimate.usage)} used of {formatBytes(estimate.quota)} available
            </p>
          )}
          <p className="mb-3 text-xs text-muted">
            Downloaded for offline: {formatBytes(totalDownloadedBytes)}
          </p>

          <label className="mb-3 flex items-center justify-between text-sm text-secondary">
            <span>Storage budget</span>
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                value={budgetMb ?? ''}
                onChange={(e) => setBudgetMb(Number(e.target.value))}
                onBlur={saveBudget}
                className="w-20 rounded border border-border-strong bg-surface px-2 py-1 text-right text-primary"
              />
              <span className="text-xs text-subtle">MB</span>
            </span>
          </label>

          {typeof navigator.storage?.persist === 'function' && persisted === false && (
            <button
              onClick={requestPersistence}
              className="mb-3 w-full rounded border border-border-strong py-1.5 text-xs text-secondary"
            >
              Request persistent storage
            </button>
          )}

          {downloadedBooks.length > 0 && (
            <ul className="divide-y divide-border border-t border-border pt-2">
              {downloadedBooks.map((b) => (
                <li key={b.bookId} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm text-primary">{b.title}</p>
                    <p className="text-xs text-subtle">{formatBytes(b.bytes)}</p>
                  </div>
                  <button
                    onClick={() => void removeBookDownload(b.bookId)}
                    className="text-xs text-red-400"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <AppearanceCard />

        <section className="rounded-lg border border-border p-4 lg:col-span-3">
          <h2 className="mb-2 text-sm font-medium text-primary">Library index</h2>

          {justConnected === 'google_drive' && (
            <p className="mb-3 rounded bg-success-soft px-3 py-2 text-xs text-success-soft-text">
              Google Drive connected. Upload audiobooks into the "OzzBooks Audiobooks" folder in your Drive, then
              rescan below to add them.
            </p>
          )}

          {sources.map((source) => (
            <SourceStatusCard key={source.id} source={source} onRescanned={refreshSources} />
          ))}

          {/* Hidden once a Google Drive source already exists (or until we've
              confirmed one doesn't — see sourcesLoaded) — clicking this
              always starts a brand-new connection (no sourceId), which would
              create a second "OzzBooks Audiobooks" folder + duplicate source
              rather than reusing the existing one. Re-authorizing an existing
              but broken connection goes through SourceStatusCard's own
              "Reconnect" button instead, which does pass the existing
              sourceId. */}
          {sourcesLoaded && !sources.some((s) => s.type === 'google_drive') && (
            <button
              onClick={() => connectGoogleDrive()}
              className="mt-2 w-full rounded-lg border border-border-strong py-2 text-sm text-secondary"
            >
              Connect Google Drive
            </button>
          )}

          <MetadataEnrichmentCard />
          <NightlyRescanCard />
        </section>

        <section className="rounded-lg border border-border p-4">
          <h2 className="mb-1 text-sm font-medium text-primary">Account</h2>
          <p className="mb-3 text-sm text-muted">{auth.user?.email}</p>
          <button
            onClick={auth.logout}
            className="mb-1 rounded-lg border border-border-strong px-3 py-2 text-sm text-primary"
          >
            Log out
          </button>
          <ChangePasswordForm />
          <ChangeEmailForm />
        </section>
      </div>

      <p className="mt-6 text-center text-xs text-subtle">OzzBooks — Phase 1</p>
    </div>
  )
}
