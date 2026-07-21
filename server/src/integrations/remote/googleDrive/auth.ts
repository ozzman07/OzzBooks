import { config } from '../../../config.js'
import type { DecryptedCredentials } from '../types.js'

// Non-sensitive scope — avoids Google's paid third-party verification
// review requirement (see the plan's Google Cloud Console setup notes).
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

/**
 * Checked lazily, only when the OAuth flow is actually used — NOT at
 * server startup or module load. These genuinely don't exist until the
 * Google Cloud Console setup is done, and gating server boot on them
 * would take the whole app down over a feature only one user is setting
 * up (this is exactly what happened with credentialsEncryptionKey
 * earlier — do not repeat it here).
 */
function requireOAuthConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  const { clientId, clientSecret, redirectUri } = config.googleOAuth
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Google OAuth is not configured — set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI',
    )
  }
  return { clientId, clientSecret, redirectUri }
}

export function getAuthorizationUrl(state: string): string {
  const { clientId, redirectUri } = requireOAuthConfig()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // forces a refresh token even on a reconnect, not just first-time consent
    state,
  })
  return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
  token_type: string
  error?: string
  error_description?: string
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json()) as TokenResponse
  if (!res.ok || json.error) {
    // Google's own error codes (invalid_grant, etc.) are embedded
    // verbatim here — credentials.ts's isPermanentAuthFailure
    // pattern-matches on exactly these strings to detect a revoked
    // grant, so this message shape is load-bearing, not just for humans.
    const detail = json.error_description ? ` (${json.error_description})` : ''
    throw new Error(`Google OAuth token request failed: ${json.error ?? res.status}${detail}`)
  }
  return json
}

export async function exchangeCodeForTokens(code: string): Promise<DecryptedCredentials> {
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig()
  const json = await requestToken(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  )
  if (!json.refresh_token) {
    // Shouldn't happen with access_type=offline + prompt=consent, but a
    // credential with no refresh token is useless once the access token
    // expires — fail loudly here rather than silently storing something
    // half-broken that only surfaces as a confusing failure later.
    throw new Error('Google did not return a refresh token — retry the connect flow')
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    scope: json.scope,
    expiresInSeconds: json.expires_in,
  }
}

/** Matches RemoteProvider's refreshToken(credentials) signature exactly —
 * this is what gets wired up as googleDrive/provider.ts's implementation. */
export async function refreshAccessToken(current: DecryptedCredentials): Promise<DecryptedCredentials> {
  const { clientId, clientSecret } = requireOAuthConfig()
  const json = await requestToken(
    new URLSearchParams({
      refresh_token: current.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  )
  return {
    ...current,
    accessToken: json.access_token,
    // Google generally doesn't re-issue a refresh_token on a refresh
    // call — keep the existing one unless a new one is actually given.
    refreshToken: json.refresh_token ?? current.refreshToken,
    scope: json.scope ?? current.scope,
    expiresInSeconds: json.expires_in,
  }
}

/** Invalidates the grant on Google's side (revoking either token type
 * revokes the whole grant), so "Disconnect" removes OzzBooks from the
 * user's Google Account third-party access list, not just locally.
 * Callers treat this as best-effort — an already-invalid token 400s here,
 * which shouldn't block the local disconnect from proceeding. */
export async function revokeToken(token: string): Promise<void> {
  const res = await fetch(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  })
  if (!res.ok) {
    throw new Error(`Google token revocation failed: ${res.status}`)
  }
}
