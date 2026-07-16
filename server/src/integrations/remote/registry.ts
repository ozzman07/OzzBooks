import type { RemoteProvider } from './types.js'

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
