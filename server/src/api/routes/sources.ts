import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { SourceRow } from '../../types.js'
import { scanSource } from '../../ingestion/scan.js'

export const sourcesRouter = Router()

sourcesRouter.get('/', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT sources.*,
         (SELECT COUNT(*) FROM books WHERE books.source_id = sources.id AND books.status = 'active') AS book_count,
         (SELECT COUNT(*) FROM books WHERE books.source_id = sources.id AND books.status = 'missing') AS missing_count
       FROM sources
       ORDER BY created_at`,
    )
    .all()
  res.json(rows)
})

// Per-file failures from the most recent scan (see scan_issues in schema.sql
// for why this is "most recent" rather than an accumulating history).
sourcesRouter.get('/:id/issues', (req, res) => {
  const source = getDb().prepare('SELECT id FROM sources WHERE id = ?').get(req.params.id)
  if (!source) {
    res.status(404).json({ error: 'source not found' })
    return
  }
  const issues = getDb()
    .prepare('SELECT * FROM scan_issues WHERE source_id = ? ORDER BY occurred_at DESC')
    .all(req.params.id)
  res.json(issues)
})

sourcesRouter.post('/', (req, res) => {
  const { type, label, pathScope } = req.body ?? {}
  if (!type || !label || !pathScope) {
    res.status(400).json({ error: 'type, label, and pathScope are required' })
    return
  }

  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)')
    .run(id, type, label, pathScope)

  const row = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id)
  res.status(201).json(row)
})

// Sources are editable in place — credentials, path/scope, display label —
// never delete+recreate, since books.source_id must stay stable.
sourcesRouter.patch('/:id', (req, res) => {
  const existing = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined
  if (!existing) {
    res.status(404).json({ error: 'source not found' })
    return
  }

  const label = req.body?.label ?? existing.label
  const pathScope = req.body?.pathScope ?? existing.path_scope

  getDb().prepare('UPDATE sources SET label = ?, path_scope = ? WHERE id = ?').run(label, pathScope, existing.id)
  const row = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(existing.id)
  res.json(row)
})

sourcesRouter.post('/:id/scan', async (req, res) => {
  const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined
  if (!source) {
    res.status(404).json({ error: 'source not found' })
    return
  }

  try {
    const result = await scanSource(source)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'scan failed', detail: String(err) })
  }
})
