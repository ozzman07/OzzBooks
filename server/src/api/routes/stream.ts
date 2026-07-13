import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { ChapterRow } from '../../types.js'

export const streamRouter = Router()

// res.sendFile (built on the `send` module) already implements HTTP Range
// support — 206 partial content, Accept-Ranges, Content-Range — so seeking
// and background pre-fetch work without us hand-rolling range parsing.
streamRouter.get('/:id/stream', (req, res) => {
  const chapter = getDb().prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id) as
    | ChapterRow
    | undefined
  if (!chapter) {
    res.status(404).json({ error: 'chapter not found' })
    return
  }

  res.sendFile(chapter.file_path, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'audio file not found on disk', detail: String(err) })
    }
  })
})
