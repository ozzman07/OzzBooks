import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { getDb } from '../../db/index.js'
import { getAuthorizationUrl, exchangeCodeForTokens } from '../../integrations/remote/googleDrive/auth.js'
import { googleDriveProvider } from '../../integrations/remote/googleDrive/provider.js'
import { encryptCredentials } from '../../integrations/remote/credentials.js'

// Mounted before the requireApiToken gate in app.ts, deliberately — these
// two endpoints are reached by direct browser navigation (Google's own
// redirect for the callback; a full-page redirect from the frontend for
// start, not a fetch(), since this is a consent flow, not a JSON call),
// so neither carries the app's Bearer token. Security here is Tailscale
// network-level gating (consistent with how the API token is already
// just defense-in-depth on top of that, not real per-user auth) plus the
// OAuth state parameter for CSRF protection on the callback.
export const googleAuthRouter = Router()

interface PendingAuth {
  label: string
  /** Set for a reconnect (re-authorizing an existing source whose
   * credentials_status is needs_reconnect) — null for a brand-new
   * connection. Determines whether the callback creates a new sources
   * row + managed folder, or just refreshes an existing row's
   * credentials in place (same folder, never recreated — a second
   * "OzzBooks Audiobooks" folder on reconnect would be a real bug). */
  sourceId: string | null
  createdAt: number
}
const pendingAuth = new Map<string, PendingAuth>()
const STATE_TTL_MS = 10 * 60 * 1000

function sweepStalePendingAuth(): void {
  const now = Date.now()
  for (const [state, pending] of pendingAuth) {
    if (now - pending.createdAt > STATE_TTL_MS) pendingAuth.delete(state)
  }
}

googleAuthRouter.get('/google/start', (req, res) => {
  sweepStalePendingAuth()
  const label = typeof req.query.label === 'string' && req.query.label.trim() ? req.query.label.trim() : 'Google Drive'
  const sourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.trim() ? req.query.sourceId.trim() : null
  const state = randomUUID()

  try {
    const url = getAuthorizationUrl(state)
    pendingAuth.set(state, { label, sourceId, createdAt: Date.now() })
    res.redirect(url)
  } catch (err) {
    res.status(500).send(`Google Drive isn't set up yet: ${String(err)}`)
  }
})

googleAuthRouter.get('/google/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : null
  const code = typeof req.query.code === 'string' ? req.query.code : null
  const errorParam = typeof req.query.error === 'string' ? req.query.error : null

  if (errorParam) {
    res.status(400).send(`Google sign-in was cancelled or failed: ${errorParam}`)
    return
  }
  const pending = state ? pendingAuth.get(state) : undefined
  if (!pending) {
    res.status(400).send("This sign-in attempt is invalid or has expired — please try connecting again.")
    return
  }
  pendingAuth.delete(state!)

  if (!code) {
    res.status(400).send('Google did not return an authorization code.')
    return
  }

  try {
    const credentials = await exchangeCodeForTokens(code)
    const db = getDb()
    const expiresAt = new Date(Date.now() + (credentials.expiresInSeconds ?? 3600) * 1000).toISOString()

    if (pending.sourceId) {
      const existing = db.prepare('SELECT id FROM sources WHERE id = ?').get(pending.sourceId)
      if (!existing) {
        res.status(404).send('That source no longer exists — try connecting fresh instead.')
        return
      }
      db.prepare(
        "UPDATE sources SET credentials = ?, credentials_expires_at = ?, credentials_status = 'ok' WHERE id = ?",
      ).run(encryptCredentials(credentials), expiresAt, pending.sourceId)
    } else {
      const folder = await googleDriveProvider.ensureManagedFolder(credentials)
      const sourceId = randomUUID()
      db.prepare(
        `INSERT INTO sources (id, type, label, path_scope, credentials, credentials_expires_at, credentials_status)
         VALUES (?, 'google_drive', ?, ?, ?, ?, 'ok')`,
      ).run(sourceId, pending.label, folder.folderId, encryptCredentials(credentials), expiresAt)
    }

    res.redirect('/settings?connected=google_drive')
  } catch (err) {
    res.status(500).send(`Couldn't finish connecting Google Drive: ${String(err)}`)
  }
})
