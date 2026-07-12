function requireEnvInProduction(name: string, devFallback: string): string {
  const value = process.env[name]
  if (value) return value
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be set in production`)
  }
  return devFallback
}

export const config = {
  port: Number(process.env.PORT ?? 4300),
  databaseUrl: requireEnvInProduction(
    'DATABASE_URL',
    'postgres://ozzbooks:ozzbooks_dev@localhost:5432/ozzbooks_cloud',
  ),
  // Signs session tokens — a leaked/weak secret here compromises every
  // user's account, unlike the file-serving API's token which only gates
  // access to already-non-sensitive library metadata.
  jwtSecret: requireEnvInProduction('OZZBOOKS_JWT_SECRET', 'dev-only-insecure-secret'),
}
