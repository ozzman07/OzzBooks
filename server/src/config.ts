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
}

export const dbPath = path.join(config.dataDir, 'ingestion.sqlite3')
export const artworkDir = path.join(config.dataDir, 'artwork')
