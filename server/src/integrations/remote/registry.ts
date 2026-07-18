import type { RemoteProvider } from './types.js'
import type { SourceRow } from '../../types.js'
import type { ScanResult } from '../../ingestion/scan.js'

// Empty until a concrete provider (Google Drive, Dropbox, ...) registers
// itself. Nothing does yet — scan.ts and stream.ts both look this up and
// degrade gracefully (clear error, not a crash or silent no-op) when a
// source's type has no registered provider.
const providers = new Map<string, RemoteProvider>()

export function registerProvider(provider: RemoteProvider): void {
  providers.set(provider.type, provider)
}

export function getProvider(type: string): RemoteProvider | undefined {
  return providers.get(type)
}

// Kept separate from RemoteProvider deliberately: RemoteProvider is
// low-level primitives (auth, listing, streaming), a scanner is a
// provider's own orchestration of those primitives into a full scan
// (discovery, hashing, dedup, DB writes) — scan.ts's dispatch only needs
// to know this exists, never how Google Drive specifically implements
// it (avoids scan.ts importing from googleDrive/ directly, which would
// be a circular import back into scan.ts itself for the primitives
// remoteScan.ts reuses, like writeBookAndChapters).
type Scanner = (source: SourceRow, provider: RemoteProvider) => Promise<ScanResult>
const scanners = new Map<string, Scanner>()

export function registerScanner(type: string, scan: Scanner): void {
  scanners.set(type, scan)
}

export function getScanner(type: string): Scanner | undefined {
  return scanners.get(type)
}
