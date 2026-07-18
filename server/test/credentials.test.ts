import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DecryptedCredentials, RemoteProvider } from '../src/integrations/remote/types.js'

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-credentials-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
}, 30_000)

describe('encryptCredentials / decryptCredentials', () => {
  it('round-trips a credentials object through encryption', async () => {
    const { encryptCredentials, decryptCredentials } = await import('../src/integrations/remote/credentials.js')
    const original: DecryptedCredentials = { accessToken: 'access-123', refreshToken: 'refresh-456', scope: 'drive.file' }

    const blob = encryptCredentials(original)
    expect(decryptCredentials(blob)).toEqual(original)
  })

  it('produces a different blob (fresh IV) each time, even for identical input', async () => {
    const { encryptCredentials } = await import('../src/integrations/remote/credentials.js')
    const credentials: DecryptedCredentials = { accessToken: 'same', refreshToken: 'same' }

    const blobA = encryptCredentials(credentials)
    const blobB = encryptCredentials(credentials)
    expect(blobA).not.toBe(blobB)
    // IV is the first of the three ':'-joined segments
    expect(blobA.split(':')[0]).not.toBe(blobB.split(':')[0])
  })

  it('rejects a tampered ciphertext (GCM auth tag check fails)', async () => {
    const { encryptCredentials, decryptCredentials } = await import('../src/integrations/remote/credentials.js')
    const blob = encryptCredentials({ accessToken: 'a', refreshToken: 'b' })
    const [iv, authTag, ciphertext] = blob.split(':')

    // Flip a byte in the ciphertext.
    const tamperedBuf = Buffer.from(ciphertext, 'base64')
    tamperedBuf[0] = tamperedBuf[0] ^ 0xff
    const tampered = [iv, authTag, tamperedBuf.toString('base64')].join(':')

    expect(() => decryptCredentials(tampered)).toThrow()
  })

  it('rejects a malformed blob', async () => {
    const { decryptCredentials } = await import('../src/integrations/remote/credentials.js')
    expect(() => decryptCredentials('not-a-real-blob')).toThrow('malformed credentials blob')
  })
})

describe('getValidAccessToken', () => {
  async function insertSource(overrides: { credentials: string; expiresAt: string | null }) {
    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    const id = randomUUID()
    db.prepare(
      `INSERT INTO sources (id, type, label, path_scope, credentials, credentials_expires_at)
       VALUES (?, 'google_drive', 'Test Drive', 'root-folder-id', ?, ?)`,
    ).run(id, overrides.credentials, overrides.expiresAt)
    return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as any
  }

  it('returns the current token without refreshing when not close to expiry', async () => {
    const { encryptCredentials, getValidAccessToken } = await import('../src/integrations/remote/credentials.js')
    const source = await insertSource({
      credentials: encryptCredentials({ accessToken: 'still-good', refreshToken: 'r' }),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })

    let refreshCalls = 0
    const provider: RemoteProvider = {
      type: 'google_drive',
      refreshToken: async () => {
        refreshCalls++
        throw new Error('should not be called')
      },
      ensureManagedFolder: async () => ({ folderId: 'x' }),
      listTree: async () => [],
      getMetadataAccess: async () => ({ url: '', headers: {} }),
    }

    const credentials = await getValidAccessToken(source, provider)
    expect(credentials.accessToken).toBe('still-good')
    expect(refreshCalls).toBe(0)
  })

  it('refreshes and persists new credentials when expired, and updates credentials_expires_at', async () => {
    const { encryptCredentials, decryptCredentials, getValidAccessToken } = await import(
      '../src/integrations/remote/credentials.js'
    )
    const { getDb } = await import('../src/db/index.js')
    const source = await insertSource({
      credentials: encryptCredentials({ accessToken: 'stale', refreshToken: 'r' }),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    })

    const provider: RemoteProvider = {
      type: 'google_drive',
      refreshToken: async (current) => ({ ...current, accessToken: 'fresh-token', expiresInSeconds: 3600 }),
      ensureManagedFolder: async () => ({ folderId: 'x' }),
      listTree: async () => [],
      getMetadataAccess: async () => ({ url: '', headers: {} }),
    }

    const credentials = await getValidAccessToken(source, provider)
    expect(credentials.accessToken).toBe('fresh-token')

    const updated = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(source.id) as any
    expect(decryptCredentials(updated.credentials).accessToken).toBe('fresh-token')
    expect(new Date(updated.credentials_expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(updated.credentials_status).toBe('ok')
  })

  it('de-dupes concurrent refreshes for the same source into a single call', async () => {
    const { encryptCredentials, getValidAccessToken } = await import('../src/integrations/remote/credentials.js')
    const source = await insertSource({
      credentials: encryptCredentials({ accessToken: 'stale', refreshToken: 'r' }),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    let refreshCalls = 0
    const provider: RemoteProvider = {
      type: 'google_drive',
      refreshToken: async (current) => {
        refreshCalls++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { ...current, accessToken: 'fresh', expiresInSeconds: 3600 }
      },
      ensureManagedFolder: async () => ({ folderId: 'x' }),
      listTree: async () => [],
      getMetadataAccess: async () => ({ url: '', headers: {} }),
    }

    const [a, b, c] = await Promise.all([
      getValidAccessToken(source, provider),
      getValidAccessToken(source, provider),
      getValidAccessToken(source, provider),
    ])
    expect([a.accessToken, b.accessToken, c.accessToken]).toEqual(['fresh', 'fresh', 'fresh'])
    expect(refreshCalls).toBe(1)
  })

  it('marks credentials_status needs_reconnect on a permanent auth failure, without retrying', async () => {
    const { encryptCredentials, getValidAccessToken } = await import('../src/integrations/remote/credentials.js')
    const { getDb } = await import('../src/db/index.js')
    const source = await insertSource({
      credentials: encryptCredentials({ accessToken: 'stale', refreshToken: 'revoked' }),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    const provider: RemoteProvider = {
      type: 'google_drive',
      refreshToken: async () => {
        throw new Error('invalid_grant: token has been revoked')
      },
      ensureManagedFolder: async () => ({ folderId: 'x' }),
      listTree: async () => [],
      getMetadataAccess: async () => ({ url: '', headers: {} }),
    }

    await expect(getValidAccessToken(source, provider)).rejects.toThrow('invalid_grant')

    const updated = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(source.id) as any
    expect(updated.credentials_status).toBe('needs_reconnect')
  })
})
