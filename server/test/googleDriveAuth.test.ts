import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.ts.net/api/sources/oauth/google/callback'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getAuthorizationUrl', () => {
  it('builds a consent URL with the expected query params', async () => {
    const { getAuthorizationUrl } = await import('../src/integrations/remote/googleDrive/auth.js')
    const url = new URL(getAuthorizationUrl('some-state-token'))

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.ts.net/api/sources/oauth/google/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('some-state-token')
  })
})

describe('exchangeCodeForTokens', () => {
  it('returns credentials on a successful exchange', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: 'access-123',
          refresh_token: 'refresh-456',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.file',
          token_type: 'Bearer',
        }),
      })),
    )

    const { exchangeCodeForTokens } = await import('../src/integrations/remote/googleDrive/auth.js')
    const credentials = await exchangeCodeForTokens('some-auth-code')

    expect(credentials).toEqual({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      scope: 'https://www.googleapis.com/auth/drive.file',
      expiresInSeconds: 3600,
    })
  })

  it('throws with a clear message if Google returns an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'invalid_grant', error_description: 'Malformed auth code' }),
      })),
    )

    const { exchangeCodeForTokens } = await import('../src/integrations/remote/googleDrive/auth.js')
    await expect(exchangeCodeForTokens('bad-code')).rejects.toThrow('invalid_grant')
  })

  it('throws if Google omits the refresh token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: 'access-only',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.file',
          token_type: 'Bearer',
        }),
      })),
    )

    const { exchangeCodeForTokens } = await import('../src/integrations/remote/googleDrive/auth.js')
    await expect(exchangeCodeForTokens('some-code')).rejects.toThrow('did not return a refresh token')
  })
})

describe('refreshAccessToken', () => {
  it('returns a fresh access token, keeping the existing refresh token if none is reissued', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: 'fresh-access',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/drive.file',
          token_type: 'Bearer',
        }),
      })),
    )

    const { refreshAccessToken } = await import('../src/integrations/remote/googleDrive/auth.js')
    const result = await refreshAccessToken({ accessToken: 'stale', refreshToken: 'original-refresh' })

    expect(result.accessToken).toBe('fresh-access')
    expect(result.refreshToken).toBe('original-refresh')
    expect(result.expiresInSeconds).toBe(3600)
  })

  it('propagates a revoked-grant error in a form credentials.ts can detect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      })),
    )

    const { refreshAccessToken } = await import('../src/integrations/remote/googleDrive/auth.js')
    await expect(refreshAccessToken({ accessToken: 'stale', refreshToken: 'revoked' })).rejects.toThrow(
      'invalid_grant',
    )
  })
})
