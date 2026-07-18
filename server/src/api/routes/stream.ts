import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { ChapterRow, SourceRow } from '../../types.js'
import { proxyRemoteStream } from './streamProxy.js'

export const streamRouter = Router()

// res.sendFile (built on the `send` module) already implements HTTP Range
// support — 206 partial content, Accept-Ranges, Content-Range — so seeking
// and background pre-fetch work without us hand-rolling range parsing.
// This path is untouched for local/synology chapters; anything else
// (remote sources) is delegated to streamProxy.ts instead.
streamRouter.get('/:id/stream', async (req, res) => {
  const chapter = getDb().prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id) as
    | ChapterRow
    | undefined
  if (!chapter) {
    res.status(404).json({ error: 'chapter not found' })
    return
  }

  const sourceAndFormat = getDb()
    .prepare(
      'SELECT sources.*, books.format AS book_format FROM sources JOIN books ON books.source_id = sources.id WHERE books.id = ?',
    )
    .get(chapter.book_id) as (SourceRow & { book_format: string }) | undefined
  if (!sourceAndFormat) {
    res.status(404).json({ error: 'source not found for chapter' })
    return
  }
  const { book_format: bookFormat, ...source } = sourceAndFormat

  if (source.type !== 'local' && source.type !== 'synology') {
    await proxyRemoteStream(req, res, source, chapter, bookFormat)
    return
  }

  res.sendFile(chapter.file_path, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'audio file not found on disk', detail: String(err) })
    }
  })
})
