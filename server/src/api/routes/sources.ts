import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { getDb } from '../../db/index.js'
import type { SourceRow } from '../../types.js'
import { browseSourceDirectory } from '../../ingestion/relink.js'
import { startScan, getScanState } from '../../ingestion/scanStatus.js'
import { getProvider } from '../../integrations/remote/registry.js'
import { decryptCredentials, getValidAccessToken } from '../../integrations/remote/credentials.js'
import { markSourceBooksMissing } from '../../integrations/remote/googleDrive/remoteScan.js'
import { getFileMetadata } from '../../integrations/remote/googleDrive/driveClient.js'

const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

export const sourcesRouter = Router()

// Deliberately excludes `credentials` — no reason to ever send the
// encrypted OAuth token blob to a client, even encrypted (defense in
// depth: less exposure if a client-side bug or a browser extension ever
// logged a response body). Every route below that returns a source row
// to the client uses this instead of `SELECT *`.
const PUBLIC_SOURCE_COLUMNS = `
  id, type, label, path_scope, created_at,
  last_scanned_at, last_scan_found, last_scan_created,
  last_scan_updated, last_scan_failed, last_scan_skipped_duplicates,
  credentials_expires_at, credentials_status, credentials_account_label
`

sourcesRouter.get('/', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT ${PUBLIC_SOURCE_COLUMNS},
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

  const row = getDb().prepare(`SELECT ${PUBLIC_SOURCE_COLUMNS} FROM sources WHERE id = ?`).get(id)
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
  const row = getDb().prepare(`SELECT ${PUBLIC_SOURCE_COLUMNS} FROM sources WHERE id = ?`).get(existing.id)
  res.json(row)
})

// Deliberate disconnect — reuses the exact same needs_reconnect mechanism
// already built for an automatically-revoked grant (credentials.ts), so
// reconnecting later relinks books via the same source row instead of
// creating duplicates (see scan.ts's source_id-scoped content-hash relink).
sourcesRouter.post('/:id/disconnect', async (req, res) => {
  const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined
  if (!source) {
    res.status(404).json({ error: 'source not found' })
    return
  }
  if (source.type === 'local') {
    res.status(400).json({ error: 'local sources cannot be disconnected' })
    return
  }

  if (source.credentials) {
    const provider = getProvider(source.type)
    try {
      await provider?.revokeCredentials?.(decryptCredentials(source.credentials))
    } catch {
      // best-effort — token may already be invalid; proceed regardless
    }
  }

  getDb()
    .prepare("UPDATE sources SET credentials = NULL, credentials_status = 'needs_reconnect' WHERE id = ?")
    .run(source.id)
  markSourceBooksMissing(source.id)

  const row = getDb().prepare(`SELECT ${PUBLIC_SOURCE_COLUMNS} FROM sources WHERE id = ?`).get(source.id)
  res.json(row)
})

// Short-lived token for Google's Picker widget, which runs client-side and
// needs a live access token of its own to authenticate its own calls to
// Drive — the one deliberate, narrow exception to "the Drive token never
// leaves the server" (see the Picker addendum). Only the access token is
// ever returned, never the refresh token, and only for a Google Drive
// source with working credentials.
sourcesRouter.get('/:id/drive-picker-token', async (req, res) => {
  const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined
  if (!source) {
    res.status(404).json({ error: 'source not found' })
    return
  }
  if (source.type !== 'google_drive') {
    res.status(400).json({ error: 'the folder picker is only available for Google Drive sources' })
    return
  }

  try {
    const credentials = await getValidAccessToken(source, getProvider(source.type)!)
    res.json({ accessToken: credentials.accessToken })
  } catch (err) {
    res.status(503).json({ error: 'source unavailable', sourceStatus: 'needs_reconnect', detail: String(err) })
  }
})

// Repoints an existing Google Drive source at a folder picked through
// Picker, instead of the auto-created managed folder — see the Picker
// addendum. Validates the folder is actually accessible and actually a
// folder before accepting it (Picker should already guarantee both, but a
// real API call is worth it to fail clearly rather than silently). Books
// under the old path_scope naturally get marked missing on the next scan,
// same as any other folder-moved-away scenario scan.ts already handles —
// no special-case cleanup needed here.
sourcesRouter.post('/:id/folder', async (req, res) => {
  const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined
  if (!source) {
    res.status(404).json({ error: 'source not found' })
    return
  }
  if (source.type !== 'google_drive') {
    res.status(400).json({ error: 'picking a folder is only available for Google Drive sources' })
    return
  }
  const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId.trim() : ''
  if (!folderId) {
    res.status(400).json({ error: 'folderId is required' })
    return
  }

  let credentials
  try {
    credentials = await getValidAccessToken(source, getProvider(source.type)!)
  } catch (err) {
    res.status(503).json({ error: 'source unavailable', sourceStatus: 'needs_reconnect', detail: String(err) })
    return
  }

  let file
  try {
    file = await getFileMetadata(credentials.accessToken, folderId)
  } catch (err) {
    console.error(`[sources] folder validation failed for source ${source.id}, folderId ${folderId}:`, err)
    res.status(400).json({ error: "couldn't access that folder", detail: String(err) })
    return
  }
  if (file.mimeType !== DRIVE_FOLDER_MIME_TYPE) {
    res.status(400).json({ error: 'the selected item is not a folder', detail: `mimeType was ${file.mimeType}` })
    return
  }

  getDb().prepare('UPDATE sources SET path_scope = ? WHERE id = ?').run(folderId, source.id)
  const row = getDb().prepare(`SELECT ${PUBLIC_SOURCE_COLUMNS} FROM sources WHERE id = ?`).get(source.id)
  res.json(row)
})

// Manual relink fallback when the ranked suggestions (books.ts's
// relink-candidates endpoint) don't have the right file — one-level
// directory listing so the client can navigate folder by folder.
sourcesRouter.get('/:id/browse', async (req, res) => {
  const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined
  if (!source) {
    res.status(404).json({ error: 'source not found' })
    return
  }

  const relPath = typeof req.query.path === 'string' ? req.query.path : ''
  try {
    const entries = await browseSourceDirectory(source, relPath)
    res.json(entries)
  } catch (err) {
    res.status(400).json({ error: 'browse failed', detail: String(err) })
  }
})

// Fire-and-forget: a real scan can take well over an hour on a large
// library, so this returns immediately instead of blocking on the whole
// thing — a client on a phone would otherwise lose the response the
// moment the tab backgrounds mid-request. Poll GET /:id/scan-status for
// progress/result instead.
sourcesRouter.post('/:id/scan', (req, res) => {
  const source = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id) as
    | SourceRow
    | undefined
  if (!source) {
    res.status(404).json({ error: 'source not found' })
    return
  }
  res.status(202).json(startScan(source))
})

sourcesRouter.get('/:id/scan-status', (req, res) => {
  const source = getDb().prepare('SELECT id FROM sources WHERE id = ?').get(req.params.id)
  if (!source) {
    res.status(404).json({ error: 'source not found' })
    return
  }
  res.json(getScanState(req.params.id))
})
