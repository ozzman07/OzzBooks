import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const TEST_TOKEN = 'test-token-123'
let app: import('express').Express

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-picker-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  process.env.OZZBOOKS_API_TOKEN = TEST_TOKEN

  const { createApp } = await import('../src/api/app.js')
  app = createApp()
}, 30_000)

afterEach(() => {
  vi.unstubAllGlobals()
})

// credentials_expires_at far in the future so getValidAccessToken never
// needs to refresh (and therefore never needs a mocked token-endpoint
// fetch) for the tests that don't care about that path.
const FAR_FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()

async function insertDriveSource(overrides: Partial<{ credentialsStatus: string; folderId: string }> = {}): Promise<string> {
  const { getDb } = await import('../src/db/index.js')
  const { encryptCredentials } = await import('../src/integrations/remote/credentials.js')
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO sources (id, type, label, path_scope, credentials, credentials_expires_at, credentials_status)
       VALUES (?, 'google_drive', 'Google Drive', ?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.folderId ?? 'original-folder-id',
      encryptCredentials({ accessToken: 'valid-access-token', refreshToken: 'r' }),
      FAR_FUTURE,
      overrides.credentialsStatus ?? 'ok',
    )
  return id
}

async function insertLocalSource(): Promise<string> {
  const { getDb } = await import('../src/db/index.js')
  const id = randomUUID()
  getDb()
    .prepare(`INSERT INTO sources (id, type, label, path_scope) VALUES (?, 'local', 'Local', '/some/path')`)
    .run(id)
  return id
}

describe('GET /api/sources/:id/drive-picker-token', () => {
  it('returns the access token for a working Google Drive source', async () => {
    const sourceId = await insertDriveSource()
    const res = await request(app)
      .get(`/api/sources/${sourceId}/drive-picker-token`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBe('valid-access-token')
    expect(res.body.refreshToken).toBeUndefined()
  })

  it('404s for a nonexistent source', async () => {
    const res = await request(app)
      .get('/api/sources/does-not-exist/drive-picker-token')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(404)
  })

  it('400s for a non-Google-Drive source', async () => {
    const sourceId = await insertLocalSource()
    const res = await request(app)
      .get(`/api/sources/${sourceId}/drive-picker-token`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(400)
  })

  it('503s when the source needs reconnecting', async () => {
    const { getDb } = await import('../src/db/index.js')
    const sourceId = await insertDriveSource()
    getDb().prepare("UPDATE sources SET credentials = NULL, credentials_status = 'needs_reconnect' WHERE id = ?").run(sourceId)

    const res = await request(app)
      .get(`/api/sources/${sourceId}/drive-picker-token`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(503)
    expect(res.body.sourceStatus).toBe('needs_reconnect')
  })
})

describe('POST /api/sources/:id/folder', () => {
  it('updates path_scope after confirming the picked id is an accessible folder', async () => {
    const sourceId = await insertDriveSource()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('picked-folder-id')
        return { ok: true, json: async () => ({ id: 'picked-folder-id', name: 'Audiobooks', mimeType: 'application/vnd.google-apps.folder' }) }
      }),
    )

    const res = await request(app)
      .post(`/api/sources/${sourceId}/folder`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ folderId: 'picked-folder-id' })

    expect(res.status).toBe(200)
    expect(res.body.path_scope).toBe('picked-folder-id')

    const { getDb } = await import('../src/db/index.js')
    const row = getDb().prepare('SELECT path_scope FROM sources WHERE id = ?').get(sourceId) as any
    expect(row.path_scope).toBe('picked-folder-id')
  })

  it('rejects a folderId that resolves to a file, not a folder', async () => {
    const sourceId = await insertDriveSource()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ id: 'a-file-id', name: 'notes.txt', mimeType: 'text/plain' }) })),
    )

    const res = await request(app)
      .post(`/api/sources/${sourceId}/folder`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ folderId: 'a-file-id' })

    expect(res.status).toBe(400)
    const { getDb } = await import('../src/db/index.js')
    const row = getDb().prepare('SELECT path_scope FROM sources WHERE id = ?').get(sourceId) as any
    expect(row.path_scope).toBe('original-folder-id') // unchanged
  })

  it("rejects a folder the token can't actually access", async () => {
    const sourceId = await insertDriveSource()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => 'Not found' })))

    const res = await request(app)
      .post(`/api/sources/${sourceId}/folder`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ folderId: 'inaccessible-folder-id' })

    expect(res.status).toBe(400)
  })

  it('400s when folderId is missing', async () => {
    const sourceId = await insertDriveSource()
    const res = await request(app)
      .post(`/api/sources/${sourceId}/folder`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('404s for a nonexistent source', async () => {
    const res = await request(app)
      .post('/api/sources/does-not-exist/folder')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ folderId: 'x' })
    expect(res.status).toBe(404)
  })

  it('400s for a non-Google-Drive source', async () => {
    const sourceId = await insertLocalSource()
    const res = await request(app)
      .post(`/api/sources/${sourceId}/folder`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ folderId: 'x' })
    expect(res.status).toBe(400)
  })
})
