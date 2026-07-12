import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { BookRow } from '../../types.js'

export const artworkRouter = Router()

artworkRouter.get('/:id/artwork/:size', (req, res) => {
  const { size } = req.params
  if (size !== 'thumb' && size !== 'full') {
    res.status(400).json({ error: 'size must be "thumb" or "full"' })
    return
  }

  const book = getDb().prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as BookRow | undefined
  const filePath = size === 'thumb' ? book?.artwork_thumb_path : book?.artwork_full_path
  if (!book || !filePath) {
    res.status(404).json({ error: 'no artwork for this book' })
    return
  }

  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'artwork file not found on disk' })
    }
  })
})
