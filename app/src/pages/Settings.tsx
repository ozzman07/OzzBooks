import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { fetchBooks, fetchSources, connectGoogleDrive, type ApiSource } from '../api/client'
import { fetchSettings, putSettings, CloudApiError } from '../api/cloudClient'
import { getAllCachedAudioFiles } from '../offline/audioFileStore'
import { deleteBookDownload } from '../offline/downloadManager'
import { SourceStatusCard } from '../components/SourceStatusCard'

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
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-slate-800 pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Change password</p>
      <input
        type="password"
        required
        placeholder="Current password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
      />
      <input
        type="password"
        required
        minLength={8}
        placeholder="New password (min 8 characters)"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
      />
      <input
        type="password"
        required
        placeholder="Confirm new password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">Password changed.</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-lg border border-slate-700 py-2 text-sm text-slate-200 disabled:opacity-40"
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-slate-800 pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Change email</p>
      <input
        type="email"
        required
        placeholder="New email"
        value={newEmail}
        onChange={(e) => setNewEmail(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
      />
      <input
        type="password"
        required
        placeholder="Current password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">Email updated.</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-lg border border-slate-700 py-2 text-sm text-slate-200 disabled:opacity-40"
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
  // Set by the OAuth callback's redirect (?connected=google_drive) — shown
  // once, then stripped from the URL so refreshing the page doesn't keep
  // re-showing it.
  const justConnected = searchParams.get('connected')

  const refreshSources = useCallback(async () => {
    setSources(await fetchSources().catch(() => []))
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
    <div className="mx-auto max-w-md px-4 pb-24 pt-6">
      <h1 className="mb-4 text-2xl font-semibold text-slate-50">Settings</h1>

      <section className="mb-6 rounded-lg border border-slate-800 p-4">
        <h2 className="mb-2 text-sm font-medium text-slate-200">Storage</h2>

        {estimate && (
          <p className="mb-2 text-xs text-slate-400">
            Device storage: {formatBytes(estimate.usage)} used of {formatBytes(estimate.quota)} available
          </p>
        )}
        <p className="mb-3 text-xs text-slate-400">
          Downloaded for offline: {formatBytes(totalDownloadedBytes)}
        </p>

        <label className="mb-3 flex items-center justify-between text-sm text-slate-300">
          <span>Storage budget</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              value={budgetMb ?? ''}
              onChange={(e) => setBudgetMb(Number(e.target.value))}
              onBlur={saveBudget}
              className="w-20 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-right text-slate-100"
            />
            <span className="text-xs text-slate-500">MB</span>
          </span>
        </label>

        {typeof navigator.storage?.persist === 'function' && persisted === false && (
          <button
            onClick={requestPersistence}
            className="mb-3 w-full rounded border border-slate-700 py-1.5 text-xs text-slate-300"
          >
            Request persistent storage
          </button>
        )}

        {downloadedBooks.length > 0 && (
          <ul className="divide-y divide-slate-800 border-t border-slate-800 pt-2">
            {downloadedBooks.map((b) => (
              <li key={b.bookId} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm text-slate-200">{b.title}</p>
                  <p className="text-xs text-slate-500">{formatBytes(b.bytes)}</p>
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

      <section className="mb-6 rounded-lg border border-slate-800 p-4">
        <h2 className="mb-2 text-sm font-medium text-slate-200">Library index</h2>

        {justConnected === 'google_drive' && (
          <p className="mb-3 rounded bg-emerald-900/40 px-3 py-2 text-xs text-emerald-300">
            Google Drive connected. Upload audiobooks into the "OzzBooks Audiobooks" folder in your Drive, then
            rescan below to add them.
          </p>
        )}

        {sources.map((source) => (
          <SourceStatusCard key={source.id} source={source} onRescanned={refreshSources} />
        ))}

        <button
          onClick={() => connectGoogleDrive()}
          className="mt-2 w-full rounded-lg border border-slate-700 py-2 text-sm text-slate-300"
        >
          Connect Google Drive
        </button>
      </section>

      <section className="mb-6 rounded-lg border border-slate-800 p-4">
        <h2 className="mb-1 text-sm font-medium text-slate-200">Account</h2>
        <p className="mb-3 text-sm text-slate-400">{auth.user?.email}</p>
        <button
          onClick={auth.logout}
          className="mb-1 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200"
        >
          Log out
        </button>
        <ChangePasswordForm />
        <ChangeEmailForm />
      </section>

      <p className="text-center text-xs text-slate-600">OzzBooks — Phase 1</p>
    </div>
  )
}
