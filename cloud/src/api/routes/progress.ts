import { Router } from 'express'
import { getPool } from '../../db/index.js'
import type { Position, ProgressRow } from '../../types.js'
import { requireAuth } from '../authMiddleware.js'

export const progressRouter = Router()
progressRouter.use(requireAuth)

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.type === 'timestamp') return typeof v.value === 'number'
  if (v.type === 'cfi') return typeof v.value === 'string'
  return false
}

// All of the user's progress rows, for the Library's "Continue Listening" shelf.
progressRouter.get('/', async (req, res) => {
  const result = await getPool().query<ProgressRow>('SELECT * FROM progress WHERE user_id = $1', [req.userId])
  res.json(result.rows)
})

progressRouter.get('/:bookId', async (req, res) => {
  const result = await getPool().query<ProgressRow>(
    'SELECT * FROM progress WHERE user_id = $1 AND book_id = $2',
    [req.userId, req.params.bookId],
  )
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'no progress for this book' })
    return
  }
  res.json(result.rows[0])
})

// Cross-device conflict handling: last-write-wins, compared by the
// position's own recorded time (updatedAt, set on-device when captured) —
// not by when the sync request happens to arrive. A device that was
// offline and syncs late with an older position must not clobber a
// newer position that already synced from another device.
progressRouter.put('/:bookId', async (req, res) => {
  const { position, chapterId, updatedAt } = req.body ?? {}
  if (!isPosition(position) || typeof updatedAt !== 'string') {
    res.status(400).json({ error: 'position ({type, value}) and updatedAt are required' })
    return
  }

  const result = await getPool().query<ProgressRow>(
    `INSERT INTO progress (user_id, book_id, position, chapter_id, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       position = EXCLUDED.position,
       chapter_id = EXCLUDED.chapter_id,
       updated_at = EXCLUDED.updated_at
     WHERE EXCLUDED.updated_at > progress.updated_at
     RETURNING *`,
    [req.userId, req.params.bookId, JSON.stringify(position), chapterId ?? null, updatedAt],
  )

  if (result.rows.length > 0) {
    res.json(result.rows[0])
    return
  }

  // The WHERE clause rejected the write (an existing row is newer) — tell
  // the client what actually won so it can reconcile local state.
  const current = await getPool().query<ProgressRow>(
    'SELECT * FROM progress WHERE user_id = $1 AND book_id = $2',
    [req.userId, req.params.bookId],
  )
  res.status(409).json(current.rows[0])
})

// Removes a book from the Continue Listening shelf (e.g. a stale entry
// left behind after a relink/rename) — a deliberate clear, not something
// that participates in last-write-wins like the PUT above.
progressRouter.delete('/:bookId', async (req, res) => {
  await getPool().query('DELETE FROM progress WHERE user_id = $1 AND book_id = $2', [req.userId, req.params.bookId])
  res.status(204).end()
})
