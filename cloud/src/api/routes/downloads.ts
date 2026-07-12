import { Router } from 'express'
import { getPool } from '../../db/index.js'
import type { DownloadRow } from '../../types.js'
import { requireAuth } from '../authMiddleware.js'

export const downloadsRouter = Router()
downloadsRouter.use(requireAuth)

// Cross-device record of what's downloaded where — the primary LRU
// eviction driver is local IndexedDB (last_played_at) per Claude.md; this
// is a mirror for cross-device awareness, not itself in the eviction path.
downloadsRouter.get('/', async (req, res) => {
  const result = await getPool().query<DownloadRow>('SELECT * FROM downloads WHERE user_id = $1', [req.userId])
  res.json(result.rows)
})

downloadsRouter.put('/:bookId/:chapterId', async (req, res) => {
  const { sizeBytes, lastPlayedAt } = req.body ?? {}

  const result = await getPool().query<DownloadRow>(
    `INSERT INTO downloads (user_id, book_id, chapter_id, size_bytes, last_played_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, book_id, chapter_id) DO UPDATE SET
       size_bytes = COALESCE($4, downloads.size_bytes),
       last_played_at = COALESCE($5, downloads.last_played_at)
     RETURNING *`,
    [req.userId, req.params.bookId, req.params.chapterId, sizeBytes ?? null, lastPlayedAt ?? null],
  )
  res.json(result.rows[0])
})

downloadsRouter.delete('/:bookId/:chapterId', async (req, res) => {
  const result = await getPool().query(
    'DELETE FROM downloads WHERE user_id = $1 AND book_id = $2 AND chapter_id = $3',
    [req.userId, req.params.bookId, req.params.chapterId],
  )
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'download record not found' })
    return
  }
  res.status(204).end()
})
