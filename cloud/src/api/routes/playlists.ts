import { Router } from 'express'
import { getPool } from '../../db/index.js'
import type { PlaylistRow, PlaylistItemRow } from '../../types.js'
import { requireAuth } from '../authMiddleware.js'

export const playlistsRouter = Router()
playlistsRouter.use(requireAuth)

playlistsRouter.get('/', async (req, res) => {
  const result = await getPool().query<PlaylistRow>(
    'SELECT * FROM playlists WHERE owner_id = $1 ORDER BY is_reserved DESC, created_at',
    [req.userId],
  )
  res.json(result.rows)
})

playlistsRouter.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const result = await getPool().query<PlaylistRow>(
    'INSERT INTO playlists (owner_id, name) VALUES ($1, $2) RETURNING *',
    [req.userId, name],
  )
  res.status(201).json(result.rows[0])
})

playlistsRouter.get('/:id', async (req, res) => {
  const playlist = await getPool().query<PlaylistRow>('SELECT * FROM playlists WHERE id = $1 AND owner_id = $2', [
    req.params.id,
    req.userId,
  ])
  if (playlist.rows.length === 0) {
    res.status(404).json({ error: 'playlist not found' })
    return
  }
  const items = await getPool().query<PlaylistItemRow>(
    'SELECT * FROM playlist_items WHERE playlist_id = $1 ORDER BY position',
    [req.params.id],
  )
  res.json({ ...playlist.rows[0], items: items.rows })
})

playlistsRouter.patch('/:id', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const result = await getPool().query<PlaylistRow>(
    `UPDATE playlists SET name = $1, updated_at = now()
     WHERE id = $2 AND owner_id = $3 AND is_reserved = false
     RETURNING *`,
    [name, req.params.id, req.userId],
  )
  if (result.rows.length > 0) {
    res.json(result.rows[0])
    return
  }
  // Distinguish "not found/not yours" (404) from "found but reserved" (400)
  // for a clearer error than a blanket not-found.
  const exists = await getPool().query('SELECT 1 FROM playlists WHERE id = $1 AND owner_id = $2', [
    req.params.id,
    req.userId,
  ])
  res.status(exists.rows.length ? 400 : 404).json({ error: exists.rows.length ? "Up Next can't be renamed" : 'playlist not found' })
})

playlistsRouter.delete('/:id', async (req, res) => {
  const result = await getPool().query(
    'DELETE FROM playlists WHERE id = $1 AND owner_id = $2 AND is_reserved = false',
    [req.params.id, req.userId],
  )
  if (result.rowCount && result.rowCount > 0) {
    res.status(204).end()
    return
  }
  const exists = await getPool().query('SELECT 1 FROM playlists WHERE id = $1 AND owner_id = $2', [
    req.params.id,
    req.userId,
  ])
  res.status(exists.rows.length ? 400 : 404).json({ error: exists.rows.length ? "Up Next can't be deleted" : 'playlist not found' })
})

// Fast path for a single-book "quick add" (e.g. BookDetail's Add to Up
// Next button) — appends at the end, no client round trip to fetch the
// current list first.
playlistsRouter.post('/:id/items', async (req, res) => {
  const bookId = typeof req.body?.bookId === 'string' ? req.body.bookId : null
  if (!bookId) {
    res.status(400).json({ error: 'bookId is required' })
    return
  }
  const owns = await getPool().query('SELECT 1 FROM playlists WHERE id = $1 AND owner_id = $2', [
    req.params.id,
    req.userId,
  ])
  if (owns.rows.length === 0) {
    res.status(404).json({ error: 'playlist not found' })
    return
  }
  const result = await getPool().query<PlaylistItemRow>(
    `INSERT INTO playlist_items (playlist_id, book_id, position)
     SELECT $1, $2, COALESCE(MAX(position) + 1, 0) FROM playlist_items WHERE playlist_id = $1
     RETURNING *`,
    [req.params.id, bookId],
  )
  res.status(201).json(result.rows[0])
})

playlistsRouter.delete('/:id/items/:itemId', async (req, res) => {
  const result = await getPool().query(
    `DELETE FROM playlist_items
     WHERE id = $1 AND playlist_id = $2 AND playlist_id IN (SELECT id FROM playlists WHERE owner_id = $3)`,
    [req.params.itemId, req.params.id, req.userId],
  )
  if (!result.rowCount) {
    res.status(404).json({ error: 'item not found' })
    return
  }
  res.status(204).end()
})

// Reorder is a full-list replace in one transaction, not per-item position
// patches — see Claude.md/the playlists plan for why (a list's order has
// no clean partial-merge the way a single scalar like progress does).
// Rejects (409) if the submitted item-id set doesn't match what's
// currently in the playlist, so a stale device can't silently drop an
// item another device just added/removed.
playlistsRouter.put('/:id/items', async (req, res) => {
  const itemIds: unknown = req.body?.itemIds
  if (!Array.isArray(itemIds) || !itemIds.every((x) => typeof x === 'string')) {
    res.status(400).json({ error: 'itemIds must be an array of item ids' })
    return
  }

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const owns = await client.query('SELECT 1 FROM playlists WHERE id = $1 AND owner_id = $2', [
      req.params.id,
      req.userId,
    ])
    if (owns.rows.length === 0) {
      await client.query('ROLLBACK')
      res.status(404).json({ error: 'playlist not found' })
      return
    }

    const current = await client.query('SELECT id FROM playlist_items WHERE playlist_id = $1', [req.params.id])
    const currentIds = new Set(current.rows.map((r) => r.id as string))
    if (itemIds.length !== currentIds.size || !itemIds.every((id) => currentIds.has(id))) {
      await client.query('ROLLBACK')
      res.status(409).json({ error: 'playlist changed since you loaded it — refresh and try again' })
      return
    }

    for (let i = 0; i < itemIds.length; i++) {
      await client.query('UPDATE playlist_items SET position = $1 WHERE id = $2', [i, itemIds[i]])
    }
    await client.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [req.params.id])
    await client.query('COMMIT')

    const result = await client.query<PlaylistItemRow>(
      'SELECT * FROM playlist_items WHERE playlist_id = $1 ORDER BY position',
      [req.params.id],
    )
    res.json(result.rows)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
})
