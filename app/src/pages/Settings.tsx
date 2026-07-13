import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { fetchBooks, fetchSources, type ApiSource } from '../api/client'
import { fetchSettings, putSettings } from '../api/cloudClient'
import { getAllCachedAudioFiles } from '../offline/audioFileStore'
import { deleteBookDownload } from '../offline/downloadManager'
import { SourceStatusCard } from '../components/SourceStatusCard'

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
  const [budgetMb, setBudgetMb] = useState<number | null>(null)
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)
  const [downloadedBooks, setDownloadedBooks] = useState<DownloadedBook[]>([])
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [sources, setSources] = useState<ApiSource[]>([])

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

      {sources.length > 0 && (
        <section className="mb-6 rounded-lg border border-slate-800 p-4">
          <h2 className="mb-2 text-sm font-medium text-slate-200">Library index</h2>
          {sources.map((source) => (
            <SourceStatusCard key={source.id} source={source} onRescanned={refreshSources} />
          ))}
        </section>
      )}

      <section className="mb-6 rounded-lg border border-slate-800 p-4">
        <h2 className="mb-1 text-sm font-medium text-slate-200">Account</h2>
        <p className="mb-3 text-sm text-slate-400">{auth.user?.email}</p>
        <button
          onClick={auth.logout}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200"
        >
          Log out
        </button>
      </section>

      <p className="text-center text-xs text-slate-600">OzzBooks — Phase 1</p>
    </div>
  )
}
