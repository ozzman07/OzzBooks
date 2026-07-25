import { randomUUID } from 'node:crypto'
import { getDb } from './index.js'
import type { ActivityAction } from '../types.js'

/**
 * Records a genuine book-level state change — created, relinked, gone
 * missing, removed, had metadata backfilled, or manually edited. Never
 * call this for a routine "still here, nothing changed" scan refresh
 * (the overwhelming majority of every scan) — that's not an event, and
 * logging it would drown out everything that actually matters. title/
 * author are snapshotted at call time rather than joined from books at
 * read time, so a 'removed' entry still reads sensibly after the book
 * row it describes is gone.
 */
export function logActivity(
  bookId: string | null,
  title: string,
  author: string | null,
  action: ActivityAction,
  detail?: string,
): void {
  getDb()
    .prepare('INSERT INTO activity_log (id, book_id, title, author, action, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), bookId, title, author, action, detail ?? null)
}
