import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

let app: import('express').Express

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-googleauth-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.ts.net/api/sources/oauth/google/callback'

  const { createApp } = await import('../src/api/app.js')
  app = createApp()
}, 30_000)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/sources/oauth/google/start', () => {
  it('redirects to Google without requiring the app Bearer token', async () => {
    // No .set('Authorization', ...) — proves the exemption from
    // requireApiToken actually works, not just that the code compiles.
    const res = await request(app).get('/api/sources/oauth/google/start?label=My%20Drive')
    expect(res.status).toBe(302)
    const location = new URL(res.headers.location)
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location.searchParams.get('client_id')).toBe('test-client-id')
    expect(location.searchParams.get('state')).toBeTruthy()
  })
})

describe('GET /api/sources/oauth/google/callback', () => {
  async function getIssuedState(label = 'My Drive'): Promise<string> {
    const res = await request(app).get(`/api/sources/oauth/google/start?label=${encodeURIComponent(label)}`)
    return new URL(res.headers.location).searchParams.get('state')!
  }

  it('rejects a missing/unknown state', async () => {
    const res = await request(app).get('/api/sources/oauth/google/callback?state=not-a-real-state&code=abc')
    expect(res.status).toBe(400)
  })

  it('rejects when Google reports an error (user cancelled consent)', async () => {
    const state = await getIssuedState()
    const res = await request(app).get(`/api/sources/oauth/google/callback?state=${state}&error=access_denied`)
    expect(res.status).toBe(400)
  })

  it('exchanges the code, creates a managed folder, stores an encrypted source row, and redirects into the app', async () => {
    const state = await getIssuedState('Son\'s Audiobooks')

    let tokenRequestSeen = false
    let folderCreateSeen = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          tokenRequestSeen = true
          return {
            ok: true,
            json: async () => ({
              access_token: 'issued-access-token',
              refresh_token: 'issued-refresh-token',
              expires_in: 3600,
              scope: 'https://www.googleapis.com/auth/drive.file',
              token_type: 'Bearer',
            }),
          }
        }
        if (url.includes('googleapis.com/drive/v3/files')) {
          folderCreateSeen = true
          const body = JSON.parse(init!.body as string)
          expect(body.mimeType).toBe('application/vnd.google-apps.folder')
          return { ok: true, json: async () => ({ id: 'managed-folder-id', name: body.name, mimeType: body.mimeType }) }
        }
        throw new Error(`unexpected fetch to ${url}`)
      }),
    )

    const res = await request(app).get(`/api/sources/oauth/google/callback?state=${state}&code=real-auth-code`)

    expect(tokenRequestSeen).toBe(true)
    expect(folderCreateSeen).toBe(true)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/settings?connected=google_drive')

    const { getDb } = await import('../src/db/index.js')
    const { decryptCredentials } = await import('../src/integrations/remote/credentials.js')
    const source = getDb().prepare("SELECT * FROM sources WHERE type = 'google_drive' ORDER BY created_at DESC LIMIT 1").get() as any

    expect(source.label).toBe("Son's Audiobooks")
    expect(source.path_scope).toBe('managed-folder-id')
    expect(source.credentials_status).toBe('ok')
    expect(decryptCredentials(source.credentials).accessToken).toBe('issued-access-token')
  })

  it('a state can only be used once (replay protection)', async () => {
    const state = await getIssuedState()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 's', token_type: 'Bearer' }),
          }
        }
        return { ok: true, json: async () => ({ id: 'x', name: 'x', mimeType: 'application/vnd.google-apps.folder' }) }
      }),
    )

    const first = await request(app).get(`/api/sources/oauth/google/callback?state=${state}&code=abc`)
    expect(first.status).toBe(302)

    const second = await request(app).get(`/api/sources/oauth/google/callback?state=${state}&code=abc`)
    expect(second.status).toBe(400)
  })

  it('reconnect (sourceId passed to start) updates the existing row in place, without creating a new folder or a duplicate source', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { encryptCredentials, decryptCredentials } = await import('../src/integrations/remote/credentials.js')
    const { randomUUID } = await import('node:crypto')

    const sourceId = randomUUID()
    getDb()
      .prepare(
        `INSERT INTO sources (id, type, label, path_scope, credentials, credentials_status)
         VALUES (?, 'google_drive', 'Existing Source', 'existing-folder-id', ?, 'needs_reconnect')`,
      )
      .run(sourceId, encryptCredentials({ accessToken: 'stale', refreshToken: 'dead' }))

    const startRes = await request(app).get(`/api/sources/oauth/google/start?sourceId=${sourceId}`)
    const state = new URL(startRes.headers.location).searchParams.get('state')!

    let folderCreateCalled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'reconnected-token', refresh_token: 'reconnected-refresh', expires_in: 3600, scope: 's', token_type: 'Bearer' }),
          }
        }
        if (url.includes('googleapis.com/drive/v3/files')) {
          folderCreateCalled = true
          return { ok: true, json: async () => ({ id: 'should-not-happen', name: 'x', mimeType: 'application/vnd.google-apps.folder' }) }
        }
        throw new Error(`unexpected fetch to ${url}`)
      }),
    )

    const res = await request(app).get(`/api/sources/oauth/google/callback?state=${state}&code=abc`)
    expect(res.status).toBe(302)
    expect(folderCreateCalled).toBe(false)

    const allDriveSources = getDb().prepare("SELECT * FROM sources WHERE type = 'google_drive'").all() as any[]
    const thisSource = allDriveSources.find((s) => s.id === sourceId)
    expect(allDriveSources.filter((s) => s.path_scope === 'existing-folder-id')).toHaveLength(1) // no duplicate
    expect(thisSource.path_scope).toBe('existing-folder-id') // unchanged
    expect(thisSource.label).toBe('Existing Source') // unchanged
    expect(thisSource.credentials_status).toBe('ok')
    expect(decryptCredentials(thisSource.credentials).accessToken).toBe('reconnected-token')
  })
})
