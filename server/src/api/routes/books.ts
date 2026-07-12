import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { BookRow, ChapterRow } from '../../types.js'

export const booksRouter = Router()

booksRouter.get('/', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT books.*, COALESCE(SUM(chapters.duration), 0) AS total_duration
       FROM books
       LEFT JOIN chapters ON chapters.book_id = books.id
       GROUP BY books.id
       ORDER BY books.title`,
    )
    .all()
  res.json(rows)
})

booksRouter.get('/:id', (req, res) => {
  const book = getDb().prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as BookRow | undefined
  if (!book) {
    res.status(404).json({ error: 'book not found' })
    return
  }

  const chapters = getDb()
    .prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx')
    .all(book.id) as ChapterRow[]

  res.json({ ...book, chapters })
})
