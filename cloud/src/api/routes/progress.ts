import { Router } from 'express'
import { getPool } from '../../db/index.js'
import type { Position, ProgressRow } from '../../types.js'
import { requireAuth } from '../authMiddleware.js'

export const progressRouter = Router()
progressRouter.use(requireAuth)

// percent, when present, is the optional cross-format sync hint (see
// Position's own comment) — must be a plausible 0-1 fraction when given,
// but its absence is always fine (best-effort, not every write has one).
function isPlausiblePercent(v: Record<string, unknown>): boolean {
  return v.percent === undefined || (typeof v.percent === 'number' && v.percent >= 0 && v.percent <= 1)
}

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.type === 'timestamp') return typeof v.value === 'number'
  if (v.type === 'cfi') return typeof v.value === 'string' && isPlausiblePercent(v)
  if (v.type === 'koreader-xpointer') return typeof v.value === 'string' && isPlausiblePercent(v)
  // Comic reading position (ComicReader.tsx) — real bug found live: this
  // type has been declared in the Position union since comics shipped,
  // but was never accepted here, so every debounced progress PUT from
  // the comic reader has silently 400'd (fire-and-forget, no .catch() at
  // the call site) since comics launched. Comic position has never
  // actually reached the cloud.
  if (v.type === 'page') return typeof v.value === 'number'
  return false
}

// All of the user's progress rows, for the Library's "Continue Listening" shelf.
progressRouter.get('/', async (req, res) => {
  const result = await getPool().query<ProgressRow>('SELECT * FROM progress WHERE user_id = $1', [req.userId])
  res.json(result.rows)
})

progressRouter.get('/:bookId', async (req, res) => {
  const result = await getPool().query<ProgressRow>(
    'SELECT * FROM progress WHERE user_id = $1 AND book_id = $2',
    [req.userId, req.params.bookId],
  )
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'no progress for this book' })
    return
  }
  res.json(result.rows[0])
})

// Cross-device conflict handling: last-write-wins, compared by the
// position's own recorded time (updatedAt, set on-device when captured) —
// not by when the sync request happens to arrive. A device that was
// offline and syncs late with an older position must not clobber a
// newer position that already synced from another device.
//
// Real bug found live: pure timestamp ordering has no concept of "how
// far into the book" a position actually is — a Kindle that's genuinely
// behind (e.g. it just opened a book at the start, before ever reading
// the PWA's percent) can still write a *more recent* timestamp than a
// PWA session that's actually much further along, silently regressing
// real reading progress back to the beginning the moment it syncs.
// PERCENT_REGRESSION_TOLERANCE guards against that: when BOTH the
// incoming and existing position carry a percent (see Position's own
// comment — optional, not every position type has one), the incoming
// write must not represent a meaningful step backward, tolerance-padded
// so minor float noise/overlap between two close positions doesn't
// spuriously reject a legitimate newer write. Falls back to pure
// timestamp ordering (the original, unchanged rule) whenever either side
// lacks a percent to compare — this is a narrowing of what wins, never a
// new way to win, so it can't make last-write-wins accept something the
// old rule would have rejected.
progressRouter.put('/:bookId', async (req, res) => {
  const { position, chapterId, updatedAt } = req.body ?? {}
  if (!isPosition(position) || typeof updatedAt !== 'string') {
    res.status(400).json({ error: 'position ({type, value}) and updatedAt are required' })
    return
  }

  const PERCENT_REGRESSION_TOLERANCE = 0.02

  const result = await getPool().query<ProgressRow>(
    `INSERT INTO progress (user_id, book_id, position, chapter_id, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       position = EXCLUDED.position,
       chapter_id = EXCLUDED.chapter_id,
       updated_at = EXCLUDED.updated_at
     WHERE EXCLUDED.updated_at > progress.updated_at
       AND (
         (progress.position->>'percent') IS NULL
         OR (EXCLUDED.position->>'percent') IS NULL
         OR (EXCLUDED.position->>'percent')::float >= (progress.position->>'percent')::float - $6
       )
     RETURNING *`,
    [req.userId, req.params.bookId, JSON.stringify(position), chapterId ?? null, updatedAt, PERCENT_REGRESSION_TOLERANCE],
  )

  if (result.rows.length > 0) {
    res.json(result.rows[0])
    return
  }

  // The WHERE clause rejected the write (an existing row is newer) — tell
  // the client what actually won so it can reconcile local state.
  const current = await getPool().query<ProgressRow>(
    'SELECT * FROM progress WHERE user_id = $1 AND book_id = $2',
    [req.userId, req.params.bookId],
  )
  res.status(409).json(current.rows[0])
})

// Removes a book from the Continue Listening shelf (e.g. a stale entry
// left behind after a relink/rename) — a deliberate clear, not something
// that participates in last-write-wins like the PUT above.
progressRouter.delete('/:bookId', async (req, res) => {
  await getPool().query('DELETE FROM progress WHERE user_id = $1 AND book_id = $2', [req.userId, req.params.bookId])
  res.status(204).end()
})
