import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-autopurge-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
}, 30_000)

async function insertSource() {
  const { getDb } = await import('../src/db/index.js')
  const db = getDb()
  const id = randomUUID()
  db.prepare("INSERT INTO sources (id, type, label, path_scope) VALUES (?, 'local', 'Auto-Purge Test', '/nowhere')").run(id)
  return id
}

async function insertMissingBook(sourceId: string, title: string, daysMissing: number) {
  const { getDb } = await import('../src/db/index.js')
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO books (id, source_id, file_path, format, title, author, status, missing_since, created_at, updated_at)
     VALUES (?, ?, ?, 'm4b', ?, 'Some Author', 'missing', datetime('now', '-' || ? || ' days'), datetime('now'), datetime('now'))`,
  ).run(id, sourceId, `/nowhere/${title}.m4b`, title, daysMissing)
  return id
}

describe('runAutoPurge', () => {
  it('deletes a book missing longer than auto_purge_after_days and logs the removal', async () => {
    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    db.prepare('UPDATE app_settings SET auto_purge_enabled = 1, auto_purge_after_days = 60 WHERE id = 1').run()

    const sourceId = await insertSource()
    const overdueId = await insertMissingBook(sourceId, 'Overdue Book', 61)
    const recentId = await insertMissingBook(sourceId, 'Recent Book', 10)

    const { runAutoPurge } = await import('../src/ingestion/autoPurge.js')
    const result = await runAutoPurge()
    expect(result.purged).toBe(1)

    expect(db.prepare('SELECT * FROM books WHERE id = ?').get(overdueId)).toBeUndefined()
    expect(db.prepare('SELECT * FROM books WHERE id = ?').get(recentId)).toBeTruthy()

    const logEntry = db.prepare("SELECT * FROM activity_log WHERE book_id = ? AND action = 'removed'").get(overdueId) as any
    expect(logEntry).toBeTruthy()
    expect(logEntry.detail).toContain('Automatically removed')
    expect(logEntry.detail).toContain('60 days')
  })

  it('does nothing when auto-purge is disabled', async () => {
    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    db.prepare('UPDATE app_settings SET auto_purge_enabled = 0, auto_purge_after_days = 60 WHERE id = 1').run()

    const sourceId = await insertSource()
    const overdueId = await insertMissingBook(sourceId, 'Should Survive', 9999)

    const { runAutoPurge } = await import('../src/ingestion/autoPurge.js')
    const result = await runAutoPurge()
    expect(result.purged).toBe(0)
    expect(db.prepare('SELECT * FROM books WHERE id = ?').get(overdueId)).toBeTruthy()
  })

  it('leaves a missing book alone if it has no missing_since (predates this feature)', async () => {
    const { getDb } = await import('../src/db/index.js')
    const db = getDb()
    db.prepare('UPDATE app_settings SET auto_purge_enabled = 1, auto_purge_after_days = 1 WHERE id = 1').run()

    const sourceId = await insertSource()
    const id = randomUUID()
    db.prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, status, missing_since, created_at, updated_at)
       VALUES (?, ?, '/nowhere/No Timestamp.m4b', 'm4b', 'No Timestamp', 'missing', NULL, datetime('now'), datetime('now'))`,
    ).run(id, sourceId)

    const { runAutoPurge } = await import('../src/ingestion/autoPurge.js')
    await runAutoPurge()
    expect(db.prepare('SELECT * FROM books WHERE id = ?').get(id)).toBeTruthy()
  })
})
