import { getDb } from '../db/index.js'
import type { AppSettingsRow, SourceRow } from '../types.js'
import { startScan, getScanState } from './scanStatus.js'
import { enrichBooks } from './enrichment/enrichBooks.js'
import { runAutoPurge } from './autoPurge.js'

const CHECK_INTERVAL_MS = 60_000
// A real scan on this library takes well under 2 hours even for the
// largest source — this is a generous ceiling, not a normal-case budget.
// Without it, a genuinely hung scan (e.g. a network mount that stops
// responding mid-walk rather than erroring) would leave `inFlight` stuck
// true forever, permanently disabling every future nightly run until the
// server restarts, silently. Giving up waiting here does NOT cancel the
// underlying scan — it keeps running (or hanging) in the background,
// this just stops it from blocking every other source and every future
// night's run along with it.
export const MAX_SCAN_WAIT_MS = 4 * 60 * 60 * 1000

function formatLocalDate(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatLocalTime(now: Date): string {
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * Pure decision function — no timers, no DB, no I/O — so it's testable
 * without mocking the clock. Fires once per day, on the first tick at or
 * after the scheduled time: if the server was asleep/off at the scheduled
 * moment, the next tick after it wakes still fires (same-day catch-up);
 * if it's down for the whole day, that day is simply skipped, not queued.
 */
export function shouldRunNow(settings: AppSettingsRow, now: Date): boolean {
  if (!settings.nightly_rescan_enabled) return false
  const today = formatLocalDate(now)
  if (settings.nightly_rescan_last_run_date === today) return false
  return formatLocalTime(now) >= settings.nightly_rescan_time
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Scans every source one at a time (not the parallel fire-and-forget
 * startScan map that the manual per-source Rescan button relies on) — a
 * large NAS scan can run well over an hour, and running every source's
 * disk/network I/O concurrently overnight is worth avoiding deliberately.
 * Reuses scanStatus.ts's existing state map, so SourceStatusCard's poll
 * loop shows "Scanning…" live during a nightly run exactly as it does for
 * a manually-triggered one — no new UI-facing state needed.
 *
 * Metadata enrichment (Open Library genre/cover lookup) runs once
 * afterward, covering whatever the scan just found — this is deliberately
 * the *only* place it runs unattended; the alternative (during/interleaved
 * with each source's scan) would mean file discovery, which matters far
 * more, waiting on a third-party network service. enrichBooks() already
 * aborts itself early and gracefully (rather than throwing) the moment
 * Open Library looks unavailable — leftover books stay un-stamped and get
 * picked up on the next nightly run — so the try/catch here is only a
 * backstop against something unrelated breaking; either way, today's scan
 * is still marked done.
 *
 * Auto-purge (deleting books missing longer than auto_purge_after_days,
 * see autoPurge.ts) runs last, once every source's missing_since is
 * current.
 */
export async function runNightlyRescan(): Promise<void> {
  const db = getDb()
  const sources = db.prepare('SELECT * FROM sources').all() as SourceRow[]
  for (const source of sources) {
    startScan(source)
    const deadline = Date.now() + MAX_SCAN_WAIT_MS
    while (getScanState(source.id).status === 'running') {
      if (Date.now() > deadline) {
        console.error(
          `Nightly rescan: source ${source.id} (${source.label}) is still running after ` +
            `${MAX_SCAN_WAIT_MS / 60_000} minutes — giving up waiting so the rest of tonight's run (and future ` +
            `nights) aren't blocked on it. The scan itself is unaffected and keeps running in the background.`,
        )
        break
      }
      await sleep(5000)
    }
  }

  try {
    await enrichBooks()
  } catch (err) {
    console.warn('Metadata enrichment failed during nightly rescan:', err)
  }

  // Runs last, after every source's missing_since is up to date from the
  // scans above — same defensive backstop as enrichment above, since a
  // purge failure shouldn't stop today's scan from being marked done.
  try {
    await runAutoPurge()
  } catch (err) {
    console.warn('Auto-purge failed during nightly rescan:', err)
  }

  db.prepare("UPDATE app_settings SET nightly_rescan_last_run_date = ?, updated_at = datetime('now') WHERE id = 1").run(
    formatLocalDate(new Date()),
  )
}

let inFlight = false

function tick(): void {
  if (inFlight) return
  const settings = getDb().prepare('SELECT * FROM app_settings WHERE id = 1').get() as AppSettingsRow
  if (!shouldRunNow(settings, new Date())) return

  inFlight = true
  runNightlyRescan().finally(() => {
    inFlight = false
  })
}

export function startNightlyRescanScheduler(): void {
  setInterval(tick, CHECK_INTERVAL_MS)
}
