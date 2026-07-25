import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'

const TEST_TOKEN = 'test-token-activity-log'

let app: import('express').Express

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-activity-log-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  process.env.OZZBOOKS_API_TOKEN = TEST_TOKEN

  const { createApp } = await import('../src/api/app.js')
  app = createApp()
}, 30_000)

describe('logActivity', () => {
  it('inserts a row with the given fields, defaulting detail to null', async () => {
    const { logActivity } = await import('../src/db/activityLog.js')
    const { getDb } = await import('../src/db/index.js')

    logActivity('book-1', 'Some Book', 'Some Author', 'created')
    logActivity('book-2', 'Another Book', null, 'removed', 'Same content found in trash')

    const rows = getDb().prepare('SELECT * FROM activity_log ORDER BY rowid').all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ book_id: 'book-1', title: 'Some Book', author: 'Some Author', action: 'created', detail: null })
    expect(rows[1]).toMatchObject({ book_id: 'book-2', title: 'Another Book', author: null, action: 'removed', detail: 'Same content found in trash' })
    expect(rows[0].created_at).toBeTruthy()
  })
})

describe('activity log routes', () => {
  it('requires the app token', async () => {
    const res = await request(app).get('/api/activity-log')
    expect(res.status).toBe(401)
  })

  it('lists entries most-recent-first', async () => {
    const { logActivity } = await import('../src/db/activityLog.js')
    logActivity('book-3', 'Third Book', 'Author Three', 'metadata_updated', 'Backfilled from Open Library: genre')

    const res = await request(app).get('/api/activity-log').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThanOrEqual(3)
    expect(res.body[0].title).toBe('Third Book') // most recently inserted
  })

  it('summary counts everything as new until the log has ever been viewed, then only counts entries since', async () => {
    // Nothing viewed yet — every existing entry counts as new.
    const beforeView = await request(app).get('/api/activity-log/summary').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(beforeView.status).toBe(200)
    expect(beforeView.body.total).toBe(beforeView.body.new)
    const totalBefore = beforeView.body.total

    const marked = await request(app).post('/api/activity-log/mark-viewed').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(marked.status).toBe(200)

    const afterView = await request(app).get('/api/activity-log/summary').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(afterView.body.total).toBe(totalBefore)
    expect(afterView.body.new).toBe(0)

    const { logActivity } = await import('../src/db/activityLog.js')
    logActivity('book-4', 'Fourth Book', null, 'created')

    const afterNewEntry = await request(app).get('/api/activity-log/summary').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(afterNewEntry.body.total).toBe(totalBefore + 1)
    expect(afterNewEntry.body.new).toBe(1)
  })
})
