import type { SourceRow } from '../../types.js'

/**
 * Whatever a provider's OAuth tokens look like, decrypted. Deliberately
 * loose beyond the two fields every provider needs — credentials.ts
 * treats this as an opaque JSON blob, it doesn't care about the
 * contents, only the provider implementation does.
 */
export interface DecryptedCredentials {
  accessToken: string
  refreshToken: string
  scope?: string
  /** How long accessToken is valid for, from the moment it was issued —
   * set by refreshToken() so credentials.ts can compute a real expiry
   * instead of guessing. Providers that don't report this get a
   * conservative fallback (see credentials.ts). */
  expiresInSeconds?: number
  [key: string]: unknown
}

export interface RemoteEntry {
  id: string
  name: string
  parentId: string | null
  kind: 'file' | 'folder'
  extension?: string
  size?: number
  modifiedTime?: string
}

/**
 * The contract any remote storage integration implements — Google Drive,
 * Dropbox, OneDrive, etc. Adding a new provider is "write a module
 * conforming to this and register it," not touching scan.ts, stream.ts,
 * or credentials.ts. None of this is called yet; see registry.ts.
 */
export interface RemoteProvider {
  /** Matches sources.type, e.g. 'google_drive'. */
  type: string
  refreshToken(credentials: DecryptedCredentials): Promise<DecryptedCredentials>
  /** Creates (or finds) the app-owned root folder new files get added to. */
  ensureManagedFolder(credentials: DecryptedCredentials): Promise<{ folderId: string; label?: string }>
  /** Recursively walks the source's folder tree, source.path_scope as the root folder id. */
  listTree(source: SourceRow, credentials: DecryptedCredentials): Promise<RemoteEntry[]>
  /** URL + headers to fetch fileId's content — used for both metadata
   * extraction (ffprobe/tokenizer) and the streaming proxy. Kept as one
   * method rather than two: for this provider they're identical, and a
   * provider where they'd genuinely differ (e.g. a signed short-lived
   * download URL vs. a metadata-only endpoint) can still return different
   * values per call, nothing here assumes they're the same. */
  getMetadataAccess(
    source: SourceRow,
    credentials: DecryptedCredentials,
    fileId: string,
  ): Promise<{ url: string; headers: Record<string, string> }>
  /** Best-effort: tell the provider to invalidate this token server-side
   * (e.g. Google's /revoke endpoint), so the app disappears from the
   * user's "connected apps" list. Optional — not every provider exposes
   * this, and a disconnect must succeed locally even if this fails. */
  revokeCredentials?(credentials: DecryptedCredentials): Promise<void>
}
