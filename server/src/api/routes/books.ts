import { Router } from 'express'
import { getDb } from '../../db/index.js'
import { logActivity } from '../../db/activityLog.js'
import type { BookRow, ChapterRow, SourceRow } from '../../types.js'
import { findRelinkCandidates, previewRelinkTarget, confirmRelink } from '../../ingestion/relink.js'
import { deleteBookAndArtwork } from '../../ingestion/scan.js'
import { backfillSeriesNumbers } from '../../ingestion/seriesNumberBackfill.js'
import { companionMatchScore, linkCompanions, unlinkCompanions } from '../../ingestion/companionLink.js'
import { isOrphanedConversion } from '../../ingestion/mobiConvert.js'
import { GENRE_OPTIONS } from '../../ingestion/enrichment/genreOptions.js'

export const booksRouter = Router()

function loadBookAndSource(bookId: string): { book: BookRow; source: SourceRow } | undefined {
  const book = getDb().prepare('SELECT * FROM books WHERE id = ?').get(bookId) as BookRow | undefined
  if (!book) return undefined
  const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(book.source_id) as SourceRow | undefined
  if (!source) return undefined
  return { book, source }
}

// ?status= lets the Library page ask for active books only (missing ones
// live exclusively on the Needs Attention page now, not mixed into the
// main grid) and the Needs Attention page ask for missing ones only,
// without either page having to filter a full-library payload client-side.
booksRouter.get('/', (req, res) => {
  const status = req.query.status === 'active' || req.query.status === 'missing' ? req.query.status : undefined
  const rows = getDb()
    .prepare(
      `SELECT books.*, sources.label AS source_label, COALESCE(SUM(chapters.duration), 0) AS total_duration,
         (SELECT id FROM chapters WHERE chapters.book_id = books.id ORDER BY idx DESC LIMIT 1) AS last_chapter_id
       FROM books
       LEFT JOIN chapters ON chapters.book_id = books.id
       LEFT JOIN sources ON sources.id = books.source_id
       ${status ? 'WHERE books.status = ?' : ''}
       GROUP BY books.id
       ORDER BY books.title`,
    )
    .all(...(status ? [status] : [])) as (BookRow & { source_label: string; total_duration: number; last_chapter_id: string | null })[]
  res.json(rows.map((row) => ({ ...row, is_orphaned_conversion: isOrphanedConversion(row) })))
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

  if ('genre' in body && body.genre !== null && !GENRE_OPTIONS.includes(body.genre)) {
    res.status(400).json({ error: 'invalid genre' })
    return
  }
  const genre = 'genre' in body ? body.genre : existing.genre
  const narrator = 'narrator' in body ? (typeof body.narrator === 'string' ? body.narrator.trim() || null : null) : existing.narrator

  getDb()
    .prepare(
      'UPDATE books SET series_name = ?, series_number = ?, series_number_source = ?, genre = ?, narrator = ? WHERE id = ?',
    )
    .run(seriesName, seriesNumber, seriesNumberSource, genre, narrator, existing.id)

  // Only a genuine change is worth a log entry — e.g. the "leave fields
  // not present in the body untouched" call pattern (an empty PATCH to
  // read back the current row) is a no-op and shouldn't show up as one.
  if (seriesName !== existing.series_name || seriesNumber !== existing.series_number) {
    logActivity(
      existing.id,
      existing.title,
      existing.author,
      'series_updated',
      `Series set to ${seriesName ?? '(none)'}${seriesNumber !== null ? ` #${seriesNumber}` : ''}`,
    )
  }
  // Reuses 'metadata_updated' — the same action type enrichBooks.ts logs
  // for an automatic genre/synopsis/cover backfill — since this is the
  // same field changing, just via a manual edit instead.
  if (genre !== existing.genre || narrator !== existing.narrator) {
    const changed = [genre !== existing.genre && 'genre', narrator !== existing.narrator && 'narrator'].filter(Boolean)
    logActivity(existing.id, existing.title, existing.author, 'metadata_updated', `Manually edited: ${changed.join(', ')}`)
  }

  res.json(getDb().prepare('SELECT * FROM books WHERE id = ?').get(existing.id))
})

// Only ever offered from the Needs Attention page, and only ever for a
// book already flagged missing — an active, playable book can't be deleted
// through this route, so a stray/misdirected call can't destroy real
// progress-bearing data by accident.
booksRouter.delete('/:id', async (req, res) => {
  const book = getDb().prepare('SELECT * FROM books WHERE id = ?').get(req.params.id) as BookRow | undefined
  if (!book) {
    res.status(404).json({ error: 'book not found' })
    return
  }
  if (book.status !== 'missing') {
    res.status(400).json({ error: 'only a missing book can be removed this way' })
    return
  }
  await deleteBookAndArtwork(book)
  logActivity(book.id, book.title, book.author, 'removed', 'Manually removed from Needs Attention')
  res.json({ ok: true })
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

  res.json({
    ...book,
    chapters,
    source_label: source.label,
    source_type: source.type,
    is_orphaned_conversion: isOrphanedConversion(book),
  })
})

// Serves the actual epub bytes — a book's own file if it's epub-primary,
// otherwise its linked companion's. Deliberately not res.sendFile with
// Range support the way stream.ts's audio route is: an epub is a small
// zip archive fetched whole by the reader (see EbookReader.tsx), not
// something that benefits from partial-content seeking. Local/Synology
// sources only for now — Google Drive ebook support needs its own
// whole-file download path, not built yet (see Claude.md).
booksRouter.get('/:id/epub', (req, res) => {
  const loaded = loadBookAndSource(req.params.id)
  if (!loaded) {
    res.status(404).json({ error: 'book not found' })
    return
  }
  const { book, source } = loaded

  let epubBook = book
  let epubSource = source
  if (book.format !== 'epub') {
    const companion = book.companion_book_id ? loadBookAndSource(book.companion_book_id) : undefined
    if (!companion || companion.book.format !== 'epub') {
      res.status(404).json({ error: 'this book has no ebook available' })
      return
    }
    epubBook = companion.book
    epubSource = companion.source
  }

  if (epubSource.type !== 'local' && epubSource.type !== 'synology') {
    res.status(501).json({ error: 'ebook serving for this source type is not implemented yet' })
    return
  }

  res.setHeader('Content-Type', 'application/epub+zip')
  res.sendFile(epubBook.file_path, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'epub file not found on disk', detail: String(err) })
    }
  })
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

// Suggests the opposite format (audio <-> epub) as a companion match,
// ranked the same way runCompanionLinking auto-links — for anything that
// scored too low/ambiguous to link automatically. Excludes books already
// linked to something (including this one, if it somehow already has a
// companion) from the suggestion pool.
booksRouter.get('/:id/companion-candidates', (req, res) => {
  const loaded = loadBookAndSource(req.params.id)
  if (!loaded) {
    res.status(404).json({ error: 'book not found' })
    return
  }
  const { book, source } = loaded
  const oppositeFormats = book.format === 'epub' ? ['m4b', 'mp3_folder'] : ['epub']

  const candidates = getDb()
    .prepare(
      `SELECT * FROM books WHERE format IN (${oppositeFormats.map(() => '?').join(',')}) AND companion_book_id IS NULL AND id != ?`,
    )
    .all(...oppositeFormats, book.id) as BookRow[]

  const sourcesById = new Map(
    (getDb().prepare('SELECT * FROM sources').all() as SourceRow[]).map((s) => [s.id, s]),
  )

  const scored = candidates
    .map((candidate) => {
      const candidateSource = sourcesById.get(candidate.source_id)
      return candidateSource ? { candidate, score: companionMatchScore(book, source, candidate, candidateSource) } : null
    })
    .filter((s): s is { candidate: BookRow; score: number } => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)

  res.json(scored.map(({ candidate, score }) => ({ id: candidate.id, title: candidate.title, author: candidate.author, score })))
})

booksRouter.post('/:id/link-companion', (req, res) => {
  const loaded = loadBookAndSource(req.params.id)
  if (!loaded) {
    res.status(404).json({ error: 'book not found' })
    return
  }
  const targetId = typeof req.body?.targetBookId === 'string' ? req.body.targetBookId : null
  if (!targetId) {
    res.status(400).json({ error: 'targetBookId is required' })
    return
  }
  const target = getDb().prepare('SELECT * FROM books WHERE id = ?').get(targetId) as BookRow | undefined
  if (!target) {
    res.status(404).json({ error: 'target book not found' })
    return
  }
  const isAudio = (f: string) => f === 'm4b' || f === 'mp3_folder'
  if (isAudio(loaded.book.format) === isAudio(target.format)) {
    res.status(400).json({ error: 'a companion link must pair an audiobook with an ebook' })
    return
  }

  linkCompanions(loaded.book.id, target.id, `Manually linked as a companion to "${target.title}"`)
  res.json(getDb().prepare('SELECT * FROM books WHERE id = ?').get(loaded.book.id))
})

booksRouter.post('/:id/unlink-companion', (req, res) => {
  const loaded = loadBookAndSource(req.params.id)
  if (!loaded) {
    res.status(404).json({ error: 'book not found' })
    return
  }
  unlinkCompanions(loaded.book.id)
  res.json(getDb().prepare('SELECT * FROM books WHERE id = ?').get(loaded.book.id))
})
