import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { SeriesSagaRow } from '../../types.js'

export const sagasRouter = Router()

// Book-level details (counts, covers, titles) deliberately aren't joined
// in here at all — the frontend already has every book loaded via
// AppDataContext and derives series/author groupings from it client-side
// (see bookOrganize.ts's groupBySeries/groupByAuthor/groupComicsByArc).
// This router's only job is the thing nothing else has: which series
// belong to which saga, and in what order.

function listSagas(): { saga_name: string; series_count: number }[] {
  return getDb()
    .prepare('SELECT saga_name, COUNT(*) AS series_count FROM series_sagas GROUP BY saga_name ORDER BY saga_name')
    .all() as { saga_name: string; series_count: number }[]
}

// Not a 404 for an unknown name — a saga with zero series isn't a
// distinct persisted thing (see series_sagas' own schema comment), it's
// just an empty result here. The Settings "+ New saga" flow navigates
// straight to this page for a name that doesn't exist yet; the first
// "+ Add a series" call is what actually creates the first row.
function getSagaDetail(sagaName: string): { saga_name: string; series: { series_name: string; position: number }[] } {
  const series = getDb()
    .prepare('SELECT series_name, position FROM series_sagas WHERE saga_name = ? ORDER BY position')
    .all(sagaName) as Pick<SeriesSagaRow, 'series_name' | 'position'>[]
  return { saga_name: sagaName, series }
}

sagasRouter.get('/', (_req, res) => {
  res.json(listSagas())
})

sagasRouter.get('/:sagaName', (req, res) => {
  res.json(getSagaDetail(req.params.sagaName))
})

// Renames every row sharing the old name — if another saga already has
// the new name, this silently merges the two (their series combine under
// one name). Not treated as an error: genuinely the same operation as
// moving each series over one at a time.
sagasRouter.patch('/:sagaName', (req, res) => {
  const newName = typeof req.body?.sagaName === 'string' ? req.body.sagaName.trim() : ''
  if (!newName) {
    res.status(400).json({ error: 'sagaName must be a non-empty string' })
    return
  }
  getDb().prepare('UPDATE series_sagas SET saga_name = ? WHERE saga_name = ?').run(newName, req.params.sagaName)
  res.json(getSagaDetail(newName))
})

// Ungroups every series in this saga — does not touch the series or
// books themselves, only the saga membership rows.
sagasRouter.delete('/:sagaName', (req, res) => {
  getDb().prepare('DELETE FROM series_sagas WHERE saga_name = ?').run(req.params.sagaName)
  res.status(204).end()
})

// Adds a series to the saga, appended at the end (same MAX(position)+1
// pattern as playlist_items — see cloud/src/api/routes/playlists.ts).
// series_name is series_sagas' primary key, so re-adding a series that's
// currently in a *different* saga moves it here instead of erroring —
// a series can only ever belong to one saga at a time.
sagasRouter.post('/:sagaName/series', (req, res) => {
  const seriesName = typeof req.body?.seriesName === 'string' ? req.body.seriesName.trim() : ''
  if (!seriesName) {
    res.status(400).json({ error: 'seriesName must be a non-empty string' })
    return
  }
  const db = getDb()
  const seriesExists = db.prepare('SELECT 1 FROM books WHERE series_name = ? LIMIT 1').get(seriesName)
  if (!seriesExists) {
    res.status(400).json({ error: `no books found with series "${seriesName}"` })
    return
  }
  const sagaName = req.params.sagaName
  const { next } = db
    .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM series_sagas WHERE saga_name = ?')
    .get(sagaName) as { next: number }
  db.prepare(
    `INSERT INTO series_sagas (series_name, saga_name, position) VALUES (?, ?, ?)
     ON CONFLICT(series_name) DO UPDATE SET saga_name = excluded.saga_name, position = excluded.position`,
  ).run(seriesName, sagaName, next)
  res.json(getSagaDetail(sagaName))
})

// Full-list replace in one transaction, not per-item position swaps —
// same reasoning as playlist reorder: simpler than computing a minimal
// diff, and this list is never long enough (a handful of series per
// saga) for that to matter. Must be exactly the saga's current series,
// just reordered — anything else is rejected rather than silently
// adding/dropping membership through what's meant to be a pure reorder.
sagasRouter.put('/:sagaName/series', (req, res) => {
  const sagaName = req.params.sagaName
  const seriesNames: unknown = req.body?.seriesNames
  if (!Array.isArray(seriesNames) || !seriesNames.every((s) => typeof s === 'string')) {
    res.status(400).json({ error: 'seriesNames must be an array of strings' })
    return
  }
  const db = getDb()
  const existing = db.prepare('SELECT series_name FROM series_sagas WHERE saga_name = ?').all(sagaName) as {
    series_name: string
  }[]
  const existingSet = new Set(existing.map((r) => r.series_name))
  const matches = seriesNames.length === existingSet.size && seriesNames.every((s) => existingSet.has(s))
  if (!matches) {
    res.status(400).json({ error: "seriesNames must match the saga's current series exactly, just reordered" })
    return
  }
  const update = db.prepare('UPDATE series_sagas SET position = ? WHERE saga_name = ? AND series_name = ?')
  db.transaction((names: string[]) => {
    names.forEach((name, i) => update.run(i, sagaName, name))
  })(seriesNames)
  res.json(getSagaDetail(sagaName))
})

sagasRouter.delete('/:sagaName/series/:seriesName', (req, res) => {
  getDb()
    .prepare('DELETE FROM series_sagas WHERE saga_name = ? AND series_name = ?')
    .run(req.params.sagaName, req.params.seriesName)
  res.status(204).end()
})
