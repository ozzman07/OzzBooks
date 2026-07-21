import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { AppSettingsRow } from '../../types.js'

export const settingsRouter = Router()

// nightly_rescan_enabled is stored as SQLite INTEGER 0/1 — coerce to a real
// JSON boolean here so clients get a proper boolean, not a leaked storage
// detail.
function toPublicSettings(row: AppSettingsRow) {
  return {
    nightly_rescan_enabled: Boolean(row.nightly_rescan_enabled),
    nightly_rescan_time: row.nightly_rescan_time,
    nightly_rescan_last_run_date: row.nightly_rescan_last_run_date,
  }
}

function getSettings(): AppSettingsRow {
  return getDb().prepare('SELECT * FROM app_settings WHERE id = 1').get() as AppSettingsRow
}

settingsRouter.get('/', (_req, res) => {
  res.json(toPublicSettings(getSettings()))
})

// Edited in place, same convention as sources.ts's PATCH /:id — only the
// fields present in the body change, everything else is left as-is.
settingsRouter.patch('/', (req, res) => {
  const existing = getSettings()
  const enabled = req.body?.nightlyRescanEnabled ?? Boolean(existing.nightly_rescan_enabled)
  const time = req.body?.nightlyRescanTime ?? existing.nightly_rescan_time

  getDb()
    .prepare(
      "UPDATE app_settings SET nightly_rescan_enabled = ?, nightly_rescan_time = ?, updated_at = datetime('now') WHERE id = 1",
    )
    .run(enabled ? 1 : 0, time)

  res.json(toPublicSettings(getSettings()))
})
