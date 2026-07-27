import { getDb } from '../db/index.js'
import { logActivity } from '../db/activityLog.js'
import type { AppSettingsRow, BookRow } from '../types.js'
import { deleteBookAndArtwork } from './scan.js'

export interface AutoPurgeResult {
  purged: number
}

/**
 * The final tier of the missing-book safety net: a book that's sat in
 * Needs Attention past auto_purge_after_days with nobody relinking or
 * manually removing it gets deleted outright, same as a deliberate removal
 * (deleteBookAndArtwork + a 'removed' log entry) — just triggered by time
 * instead of a person. Runs once a day as part of the nightly rescan
 * (nightlyRescan.ts), after every source has finished scanning, so
 * missing_since reflects each book's latest state before this looks at it.
 */
export async function runAutoPurge(): Promise<AutoPurgeResult> {
  const db = getDb()
  const settings = db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as AppSettingsRow
  if (!settings.auto_purge_enabled) return { purged: 0 }

  const overdue = db
    .prepare<[number], BookRow>(
      `SELECT * FROM books
       WHERE status = 'missing' AND missing_since IS NOT NULL
         AND missing_since < datetime('now', '-' || ? || ' days')`,
    )
    .all(settings.auto_purge_after_days)

  for (const book of overdue) {
    await deleteBookAndArtwork(book)
    logActivity(
      book.id,
      book.title,
      book.author,
      'removed',
      `Automatically removed after being missing for over ${settings.auto_purge_after_days} days`,
    )
  }

  return { purged: overdue.length }
}
