import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { buildTestLibrary, type TestLibrary } from './fixtures.js'

const TEST_TOKEN = 'test-token-123'
let app: import('express').Express
let library: TestLibrary
let sourceId: string
let bookId: string
let chapterId: string

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-api-data-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  process.env.OZZBOOKS_API_TOKEN = TEST_TOKEN

  library = await buildTestLibrary()

  const { createApp } = await import('../src/api/app.js')
  app = createApp()
}, 30_000)

describe('health', () => {
  it('responds without requiring auth', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })
})

describe('auth', () => {
  it('rejects /api requests with no token', async () => {
    const res = await request(app).get('/api/books')
    expect(res.status).toBe(401)
  })

  it('rejects /api requests with the wrong token', async () => {
    const res = await request(app).get('/api/books').set('Authorization', 'Bearer wrong')
    expect(res.status).toBe(401)
  })
})

describe('sources + ingestion via the API', () => {
  it('creates a source and triggers a scan', async () => {
    const createRes = await request(app)
      .post('/api/sources')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ type: 'local', label: 'Test Library', pathScope: library.root })
    expect(createRes.status).toBe(201)
    sourceId = createRes.body.id

    // Fire-and-forget: the trigger returns immediately (202) rather than
    // the full result, so poll scan-status until it finishes.
    const startRes = await request(app)
      .post(`/api/sources/${sourceId}/scan`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(startRes.status).toBe(202)
    expect(['running', 'completed']).toContain(startRes.body.status) // may already be done for a tiny fixture library

    let statusRes: any
    for (let i = 0; i < 100; i++) {
      statusRes = await request(app)
        .get(`/api/sources/${sourceId}/scan-status`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      if (statusRes.body.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(statusRes.body.status).toBe('completed')
    expect(statusRes.body.result.created).toBe(11)
    expect(statusRes.body.result.failed).toBe(1) // the corrupt m4b fixture
  }, 30_000)

  it('lists sources with book counts and last-scan summary', async () => {
    const res = await request(app).get('/api/sources').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(200)
    const source = res.body.find((s: any) => s.id === sourceId)
    expect(source.book_count).toBe(11)
    expect(source.last_scan_failed).toBe(1)
    expect(source.last_scanned_at).toBeTruthy()
  })

  it('lists the file(s) that failed on the last scan', async () => {
    const res = await request(app)
      .get(`/api/sources/${sourceId}/issues`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].file_path).toContain('broken.m4b')
  })

  it('edits a source in place (same id, updated label)', async () => {
    const res = await request(app)
      .patch(`/api/sources/${sourceId}`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ label: 'Renamed Library' })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(sourceId)
    expect(res.body.label).toBe('Renamed Library')
  })

  it('lists books and returns a book with its chapters', async () => {
    const listRes = await request(app).get('/api/books').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(listRes.status).toBe(200)
    expect(listRes.body).toHaveLength(11)

    const m4bBook = listRes.body.find((b: any) => b.title === 'Mistborn: The Final Empire')
    bookId = m4bBook.id

    const detailRes = await request(app).get(`/api/books/${bookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(detailRes.status).toBe(200)
    expect(detailRes.body.chapters).toHaveLength(2)
    chapterId = detailRes.body.chapters[0].id

    // last_chapter_id drives the frontend's "finished" status derivation —
    // must point at the actual last chapter (by idx), not just any chapter.
    expect(m4bBook.last_chapter_id).toBe(detailRes.body.chapters[1].id)
  })

  it('streams chapter audio and supports HTTP Range requests', async () => {
    const fullRes = await request(app)
      .get(`/api/chapters/${chapterId}/stream`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(fullRes.status).toBe(200)
    expect(fullRes.headers['accept-ranges']).toBe('bytes')

    const rangeRes = await request(app)
      .get(`/api/chapters/${chapterId}/stream`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .set('Range', 'bytes=0-99')
    expect(rangeRes.status).toBe(206)
    expect(rangeRes.headers['content-range']).toMatch(/^bytes 0-99\//)
    expect(rangeRes.body.length ?? rangeRes.text.length).toBeGreaterThan(0)
  })

  it('503s cleanly for a chapter belonging to a source with no registered remote provider', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { randomUUID } = await import('node:crypto')
    const db = getDb()

    const remoteSourceId = randomUUID()
    db.prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)').run(
      remoteSourceId,
      'google_drive',
      'Unimplemented Drive Source',
      'some-remote-folder-id',
    )
    const remoteBookId = randomUUID()
    db.prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, status)
       VALUES (?, ?, 'gdrive://fake-file-id', 'm4b', 'Remote Book', 'active')`,
    ).run(remoteBookId, remoteSourceId)
    const remoteChapterId = randomUUID()
    db.prepare(
      `INSERT INTO chapters (id, book_id, idx, title, start_time, duration, file_path)
       VALUES (?, ?, 0, 'Chapter 1', 0, 100, 'gdrive://fake-file-id')`,
    ).run(remoteChapterId, remoteBookId)

    const res = await request(app)
      .get(`/api/chapters/${remoteChapterId}/stream`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(503)
    expect(res.body.detail).toMatch(/no provider registered/i)
  })

  it('serves cover artwork when present, 404s otherwise', async () => {
    const res = await request(app).get(`/api/books/${bookId}/artwork/thumb`).set('Authorization', `Bearer ${TEST_TOKEN}`)
    // Our synthetic fixtures have no embedded art or folder cover, so this
    // book legitimately has none — confirms the "no art" path 404s cleanly
    // rather than crashing, which is what the frontend's placeholder relies on.
    expect(res.status).toBe(404)
  })
})
