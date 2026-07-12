import { Router } from 'express'
import { getPool } from '../../db/index.js'
import type { UserSettingsRow } from '../../types.js'
import { requireAuth } from '../authMiddleware.js'

export const settingsRouter = Router()
settingsRouter.use(requireAuth)

settingsRouter.get('/', async (req, res) => {
  const result = await getPool().query<UserSettingsRow>('SELECT * FROM user_settings WHERE user_id = $1', [
    req.userId,
  ])
  if (result.rows.length === 0) {
    // Created at signup, but fall back gracefully rather than 404ing —
    // defensive against rows created before this table existed.
    res.json({ user_id: req.userId, storage_budget_mb: 2000, playback_speed: 1.0, skip_silence_enabled: false })
    return
  }
  res.json(result.rows[0])
})

settingsRouter.put('/', async (req, res) => {
  const { storageBudgetMb, playbackSpeed, skipSilenceEnabled } = req.body ?? {}

  const result = await getPool().query<UserSettingsRow>(
    `INSERT INTO user_settings (user_id, storage_budget_mb, playback_speed, skip_silence_enabled, updated_at)
     VALUES ($1, COALESCE($2, 2000), COALESCE($3, 1.0), COALESCE($4, false), now())
     ON CONFLICT (user_id) DO UPDATE SET
       storage_budget_mb = COALESCE($2, user_settings.storage_budget_mb),
       playback_speed = COALESCE($3, user_settings.playback_speed),
       skip_silence_enabled = COALESCE($4, user_settings.skip_silence_enabled),
       updated_at = now()
     RETURNING *`,
    [req.userId, storageBudgetMb ?? null, playbackSpeed ?? null, skipSilenceEnabled ?? null],
  )
  res.json(result.rows[0])
})
