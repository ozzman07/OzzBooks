import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { BookRow, ChapterRow, SourceRow } from '../../types.js'
import { findRelinkCandidates, previewRelinkTarget, confirmRelink } from '../../ingestion/relink.js'
import { backfillSeriesNumbers } from '../../ingestion/seriesNumberBackfill.js'

export const booksRouter = Router()

function loadBookAndSource(bookId: string): { book: BookRow; source: SourceRow } | undefined {
  const book = getDb().prepare('SELECT * FROM books WHERE id = ?').get(bookId) as BookRow | undefined
  if (!book) return undefined
  const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(book.source_id) as SourceRow | undefined
  if (!source) return undefined
  return { book, source }
}

booksRouter.get('/', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT books.*, COALESCE(SUM(chapters.duration), 0) AS total_duration,
         (SELECT id FROM chapters WHERE chapters.book_id = books.id ORDER BY idx DESC LIMIT 1) AS last_chapter_id
       FROM books
       LEFT JOIN chapters ON chapters.book_id = books.id
       GROUP BY books.id
       ORDER BY books.title`,
    )
    .all()
  res.json(rows)
})

// Deliberately synchronous (200, not 202+poll) — pure local string
// matching against data already in the DB, no external API/rate limit,
// so it runs against the whole library in well under a second. See
// seriesNumberBackfill.ts for why this doesn't mirror the enrichment
// job's async pattern.
booksRouter.post('/backfill-series-numbers', (_req, res) => {
  res.json(backfillSeriesNumbers())
})

booksRouter.patch('/:id', (req, res) => {
  const existing = getDb().prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as BookRow | undefined
  if (!existing) {
    res.status(404).json({ error: 'book not found' })
    return
  }
  const body = req.body ?? {}
  const seriesName = 'seriesName' in body ? body.seriesName : existing.series_name
  const seriesNumber = 'seriesNumber' in body ? body.seriesNumber : existing.series_number
  // Setting a real number locks it against being overwritten by a future
  // scan/backfill; explicitly clearing it back to null un-locks it instead
  // of leaving it permanently stuck on whatever guess came before.
  const seriesNumberSource = 'seriesNumber' in body ? (seriesNumber === null ? null : 'manual') : existing.series_number_source

  getDb()
    .prepare('UPDATE books SET series_name = ?, series_number = ?, series_number_source = ? WHERE id = ?')
    .run(seriesName, seriesNumber, seriesNumberSource, existing.id)

  res.json(getDb().prepare('SELECT * FROM books WHERE id = ?').get(existing.id))
})

booksRouter.get('/:id', (req, res) => {
  const loaded = loadBookAndSource(req.params.id)
  if (!loaded) {
    res.status(404).json({ error: 'book not found' })
    return
  }
  const { book, source } = loaded

  const chapters = getDb()
    .prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx')
    .all(book.id) as ChapterRow[]

  res.json({ ...book, chapters, source_label: source.label, source_type: source.type })
})

booksRouter.get('/:id/relink-candidates', async (req, res) => {
  const loaded = loadBookAndSource(req.params.id)
  if (!loaded) {
    res.status(404).json({ error: 'book or source not found' })
    return
  }
  try {
    const candidates = await findRelinkCandidates(loaded.source, loaded.book)
    res.json(candidates)
  } catch (err) {
    res.status(500).json({ error: 'relink candidate search failed', detail: String(err) })
  }
})

booksRouter.post('/:id/relink/preview', async (req, res) => {
  const loaded = loadBookAndSource(req.params.id)
  if (!loaded) {
    res.status(404).json({ error: 'book or source not found' })
    return
  }
  const relPath = typeof req.body?.path === 'string' ? req.body.path : null
  const format = req.body?.format === 'm4b' || req.body?.format === 'mp3_folder' ? req.body.format : null
  if (!relPath || !format) {
    res.status(400).json({ error: 'path and format are required' })
    return
  }
  try {
    const preview = await previewRelinkTarget(loaded.source, loaded.book, relPath, format)
    res.json(preview)
  } catch (err) {
    res.status(500).json({ error: 'relink preview failed', detail: String(err) })
  }
})

booksRouter.post('/:id/relink/confirm', async (req, res) => {
  const loaded = loadBookAndSource(req.params.id)
  if (!loaded) {
    res.status(404).json({ error: 'book or source not found' })
    return
  }
  const relPath = typeof req.body?.path === 'string' ? req.body.path : null
  const format = req.body?.format === 'm4b' || req.body?.format === 'mp3_folder' ? req.body.format : null
  if (!relPath || !format) {
    res.status(400).json({ error: 'path and format are required' })
    return
  }
  try {
    const result = await confirmRelink(loaded.source, loaded.book, relPath, format)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'relink confirm failed', detail: String(err) })
  }
})
