import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, dbPath } from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  mkdirSync(config.dataDir, { recursive: true })
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8')
  db.exec(schema)

  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
