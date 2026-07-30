import { Router } from 'express'
import { getPool } from '../../db/index.js'
import type { LibraryItemRow } from '../../types.js'
import { requireAuth } from '../authMiddleware.js'

export const libraryRouter = Router()
libraryRouter.use(requireAuth)

// A user's personal shelf — see schema.sql's comment on library_items for
// why this is separate from the shared catalog (server/'s SQLite).
libraryRouter.get('/', async (req, res) => {
  const result = await getPool().query<LibraryItemRow>(
    'SELECT book_id, added_at FROM library_items WHERE user_id = $1',
    [req.userId],
  )
  res.json(result.rows)
})

// Idempotent — re-adding an already-shelved book is a no-op, not an
// error, so the frontend can call this without first checking membership.
libraryRouter.post('/', async (req, res) => {
  const { bookId } = req.body ?? {}
  if (typeof bookId !== 'string' || !bookId) {
    res.status(400).json({ error: 'bookId is required' })
    return
  }

  const inserted = await getPool().query<LibraryItemRow>(
    `INSERT INTO library_items (user_id, book_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, book_id) DO NOTHING
     RETURNING book_id, added_at`,
    [req.userId, bookId],
  )
  if (inserted.rows.length > 0) {
    res.status(201).json(inserted.rows[0])
    return
  }

  // Already existed — ON CONFLICT DO NOTHING doesn't return the existing
  // row, so fetch it separately to give a consistent response either way.
  const existing = await getPool().query<LibraryItemRow>(
    'SELECT book_id, added_at FROM library_items WHERE user_id = $1 AND book_id = $2',
    [req.userId, bookId],
  )
  res.json(existing.rows[0])
})

// Removes a book from the shelf — a deliberate clear, idempotent whether
// or not it was there (same shape as progressRouter's DELETE).
libraryRouter.delete('/:bookId', async (req, res) => {
  await getPool().query('DELETE FROM library_items WHERE user_id = $1 AND book_id = $2', [
    req.userId,
    req.params.bookId,
  ])
  res.status(204).end()
})
