import path from 'node:path'

function requireEnvInProduction(name: string, devFallback: string): string {
  const value = process.env[name]
  if (value) return value
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be set in production`)
  }
  return devFallback
}

export const config = {
  port: Number(process.env.PORT ?? 4100),
  dataDir: process.env.OZZBOOKS_DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  // Defense-in-depth beyond Tailscale network gating — every /api request
  // must present this as a Bearer token.
  apiToken: requireEnvInProduction('OZZBOOKS_API_TOKEN', 'dev-local-token'),
  // Encrypts remote-source OAuth tokens at rest (see integrations/remote/
  // credentials.ts) — any passphrase-shaped string, hashed down to a real
  // AES-256 key rather than needing to be exactly 32 bytes itself. Not
  // yet required in production: no concrete remote provider exists, so
  // nothing produces real credentials for this to protect. Set
  // OZZBOOKS_CREDENTIALS_KEY (and switch this to requireEnvInProduction)
  // before a real provider ships and starts storing real OAuth tokens.
  credentialsEncryptionKey: process.env.OZZBOOKS_CREDENTIALS_KEY ?? 'dev-local-credentials-key',
}

export const dbPath = path.join(config.dataDir, 'ingestion.sqlite3')
export const artworkDir = path.join(config.dataDir, 'artwork')
