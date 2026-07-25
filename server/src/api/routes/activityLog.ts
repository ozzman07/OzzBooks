import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { AppSettingsRow } from '../../types.js'

export const activityLogRouter = Router()

// Most recent first, capped rather than paginated — this is a personal
// library's event feed, not a high-volume audit log; a simple recent-N
// list is enough for "what happened" without building pagination for a
// table that grows by tens of rows a day at most.
const MAX_ENTRIES = 200

activityLogRouter.get('/', (_req, res) => {
  const rows = getDb().prepare(`SELECT * FROM activity_log ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_ENTRIES}`).all()
  res.json(rows)
})

// "New" = logged since the Activity Log page was last opened (see
// POST /mark-viewed) — everything counts as new until it's ever been
// viewed once, rather than showing 0 (which would look like nothing had
// ever happened).
activityLogRouter.get('/summary', (_req, res) => {
  const db = getDb()
  const settings = db.prepare('SELECT activity_log_last_viewed_at FROM app_settings WHERE id = 1').get() as
    | Pick<AppSettingsRow, 'activity_log_last_viewed_at'>
    | undefined
  const total = (db.prepare('SELECT COUNT(*) AS count FROM activity_log').get() as { count: number }).count
  const newCount = settings?.activity_log_last_viewed_at
    ? (
        db
          .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM activity_log WHERE created_at > ?')
          .get(settings.activity_log_last_viewed_at) as { count: number }
      ).count
    : total
  res.json({ total, new: newCount })
})

activityLogRouter.post('/mark-viewed', (_req, res) => {
  // Same 'subsec' precision as activity_log.created_at — see schema.sql.
  getDb()
    .prepare(
      "UPDATE app_settings SET activity_log_last_viewed_at = datetime('now', 'subsec'), updated_at = datetime('now') WHERE id = 1",
    )
    .run()
  res.json({ ok: true })
})
