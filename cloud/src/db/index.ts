import pg from 'pg'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl })
  }
  return pool
}

export async function migrate(): Promise<void> {
  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8')
  await getPool().query(schema)
}

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = null
}
