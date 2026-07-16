import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { getDb } from '../../db/index.js'
import { config } from '../../config.js'
import type { SourceRow } from '../../types.js'
import type { DecryptedCredentials, RemoteProvider } from './types.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
// If a provider's refresh response doesn't report its own expiry, assume
// the conservative common case (most OAuth2 access tokens run ~1hr) rather
// than treating it as never-expiring.
const DEFAULT_EXPIRY_SECONDS = 55 * 60
const REFRESH_BUFFER_MS = 5 * 60 * 1000

function deriveKey(): Buffer {
  // AES-256 needs exactly 32 bytes; hashing the configured key means the
  // env var can be any passphrase-shaped string rather than requiring the
  // operator to produce exactly 32 raw bytes themselves.
  return createHash('sha256').update(config.credentialsEncryptionKey).digest()
}

/**
 * Encrypts an opaque JSON-serializable credentials object. Fresh random
 * IV on every call, including every re-encryption on refresh — reusing an
 * IV is the one AES-GCM mistake that actually breaks the scheme. Blob
 * format: base64(iv):base64(authTag):base64(ciphertext).
 */
export function encryptCredentials(credentials: DecryptedCredentials): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, deriveKey(), iv)
  const plaintext = Buffer.from(JSON.stringify(credentials), 'utf-8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':')
}

/** Throws if the blob is malformed or has been tampered with (GCM's auth
 * tag check fails on any modification to the ciphertext, IV, or tag). */
export function decryptCredentials(blob: string): DecryptedCredentials {
  const parts = blob.split(':')
  if (parts.length !== 3) {
    throw new Error('malformed credentials blob')
  }
  const [ivB64, authTagB64, ciphertextB64] = parts
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  const decipher = createDecipheriv(ALGORITHM, deriveKey(), iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf-8')) as DecryptedCredentials
}

// De-dupes concurrent refreshes for the same source (e.g. background
// pre-fetch and active playback both needing a token near expiry at once)
// so they share one in-flight refresh instead of racing redundant calls.
const inFlightRefreshes = new Map<string, Promise<DecryptedCredentials>>()

function isPermanentAuthFailure(err: unknown): boolean {
  // OAuth2 error codes conventionally used for "this grant is dead, no
  // point retrying" (revoked, expired beyond refresh, etc.) — not
  // exhaustive across every provider, but matches the shape providers
  // built against this interface should throw for that condition.
  const message = err instanceof Error ? err.message : String(err)
  return /invalid_grant|invalid_token|unauthorized_client/i.test(message)
}

async function refreshAndPersist(
  source: SourceRow,
  provider: RemoteProvider,
  current: DecryptedCredentials,
): Promise<DecryptedCredentials> {
  const existing = inFlightRefreshes.get(source.id)
  if (existing) return existing

  const refreshPromise = (async () => {
    try {
      const refreshed = await provider.refreshToken(current)
      const expiresInSeconds = refreshed.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()
      getDb()
        .prepare(
          "UPDATE sources SET credentials = ?, credentials_expires_at = ?, credentials_status = 'ok' WHERE id = ?",
        )
        .run(encryptCredentials(refreshed), expiresAt, source.id)
      return refreshed
    } catch (err) {
      // A permanent failure (revoked/dead grant) is not worth retrying —
      // flip status so the next scan short-circuits to marking this
      // source's books missing instead of erroring, and the UI can prompt
      // to reconnect. A transient failure (network blip) leaves status
      // alone; the caller's own retry/backoff handles that case.
      if (isPermanentAuthFailure(err)) {
        getDb().prepare("UPDATE sources SET credentials_status = 'needs_reconnect' WHERE id = ?").run(source.id)
      }
      throw err
    } finally {
      inFlightRefreshes.delete(source.id)
    }
  })()

  inFlightRefreshes.set(source.id, refreshPromise)
  return refreshPromise
}

/**
 * Returns a currently-valid access token for source, refreshing first if
 * it's expired or within REFRESH_BUFFER_MS of expiring. Callers that get
 * a 401 anyway (clock skew, a provider revoking mid-request) should treat
 * that as a one-shot signal to force a refresh and retry once, not retry
 * in a loop — a second consecutive 401 means isPermanentAuthFailure's
 * class of problem, not a token freshness problem.
 */
export async function getValidAccessToken(source: SourceRow, provider: RemoteProvider): Promise<string> {
  if (!source.credentials) {
    throw new Error(`source ${source.id} has no stored credentials`)
  }

  let credentials = decryptCredentials(source.credentials)
  const expiresAt = source.credentials_expires_at ? new Date(source.credentials_expires_at).getTime() : 0
  const needsRefresh = !expiresAt || expiresAt - Date.now() < REFRESH_BUFFER_MS

  if (needsRefresh) {
    credentials = await refreshAndPersist(source, provider, credentials)
  }

  return credentials.accessToken
}
