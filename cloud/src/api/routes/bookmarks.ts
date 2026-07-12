import { Router } from 'express'
import { getPool } from '../../db/index.js'
import type { BookmarkRow, Position } from '../../types.js'
import { requireAuth } from '../authMiddleware.js'

export const bookmarksRouter = Router()
bookmarksRouter.use(requireAuth)

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.type === 'timestamp') return typeof v.value === 'number'
  if (v.type === 'cfi') return typeof v.value === 'string'
  return false
}

bookmarksRouter.get('/', async (req, res) => {
  const bookId = typeof req.query.bookId === 'string' ? req.query.bookId : null
  const result = bookId
    ? await getPool().query<BookmarkRow>(
        'SELECT * FROM bookmarks WHERE user_id = $1 AND book_id = $2 ORDER BY created_at',
        [req.userId, bookId],
      )
    : await getPool().query<BookmarkRow>('SELECT * FROM bookmarks WHERE user_id = $1 ORDER BY created_at', [
        req.userId,
      ])
  res.json(result.rows)
})

// Bookmarks are a separate, deliberate action from continuous position —
// never overwritten by a progress sync (see Claude.md).
bookmarksRouter.post('/', async (req, res) => {
  const { bookId, position, label } = req.body ?? {}
  if (typeof bookId !== 'string' || !isPosition(position)) {
    res.status(400).json({ error: 'bookId and position ({type, value}) are required' })
    return
  }

  const result = await getPool().query<BookmarkRow>(
    'INSERT INTO bookmarks (user_id, book_id, position, label) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.userId, bookId, JSON.stringify(position), typeof label === 'string' ? label : null],
  )
  res.status(201).json(result.rows[0])
})

bookmarksRouter.delete('/:id', async (req, res) => {
  const result = await getPool().query(
    'DELETE FROM bookmarks WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId],
  )
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'bookmark not found' })
    return
  }
  res.status(204).end()
})
