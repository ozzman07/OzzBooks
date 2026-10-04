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

  // Real bug caught live: a replaced cover (enrichment, the "Look up
  // metadata online" flow, or a manual relink) writes to this exact same
  // path every time — the filename is just `{bookId}-thumb/full.png`,
  // never versioned — so with no header here, a browser that already
  // fetched this URL once has no reason to ask again, and keeps showing
  // the old image indefinitely even though the file on disk changed.
  // `no-cache` (not `no-store`) is the right fix, not a cache-busting
  // query param threaded through every <img> across the app: it still
  // lets the browser cache the bytes, just requires a conditional
  // revalidation (If-Modified-Since, using sendFile's own Last-Modified
  // header below) on every request — a cheap 304 when the file is
  // unchanged, a fresh 200 the moment it actually is.
  res.set('Cache-Control', 'no-cache')
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'artwork file not found on disk' })
    }
  })
})
