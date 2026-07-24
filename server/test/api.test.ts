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
    expect(statusRes.body.result.created).toBe(16)
    expect(statusRes.body.result.failed).toBe(1) // the corrupt m4b fixture
  }, 30_000)

  it('lists sources with book counts and last-scan summary', async () => {
    const res = await request(app).get('/api/sources').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(200)
    const source = res.body.find((s: any) => s.id === sourceId)
    expect(source.book_count).toBe(16)
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
    expect(listRes.body).toHaveLength(16)

    const m4bBook = listRes.body.find((b: any) => b.title === 'Mistborn: The Final Empire')
    bookId = m4bBook.id

    const detailRes = await request(app).get(`/api/books/${bookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(detailRes.status).toBe(200)
    expect(detailRes.body.chapters).toHaveLength(2)
    chapterId = detailRes.body.chapters[0].id

    // Joined from the book's source (see loadBookAndSource in books.ts) —
    // "Renamed Library" reflects the earlier PATCH-rename test, since these
    // tests share state sequentially against the same source row.
    expect(detailRes.body.source_label).toBe('Renamed Library')
    expect(detailRes.body.source_type).toBe('local')

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

  describe('POST /api/sources/:id/disconnect', () => {
    it('clears credentials, flips to needs_reconnect, and marks the source\'s active books missing', async () => {
      const { getDb } = await import('../src/db/index.js')
      const { encryptCredentials } = await import('../src/integrations/remote/credentials.js')
      const { randomUUID } = await import('node:crypto')
      const db = getDb()

      const disconnectSourceId = randomUUID()
      db.prepare(
        `INSERT INTO sources (id, type, label, path_scope, credentials, credentials_status)
         VALUES (?, 'google_drive', 'To Disconnect', 'some-folder-id', ?, 'ok')`,
      ).run(disconnectSourceId, encryptCredentials({ accessToken: 'a', refreshToken: 'r' }))

      const activeBookId = randomUUID()
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, status)
         VALUES (?, ?, 'gdrive://some-file-id', 'm4b', 'Disconnect Test Book', 'active')`,
      ).run(activeBookId, disconnectSourceId)

      const res = await request(app)
        .post(`/api/sources/${disconnectSourceId}/disconnect`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.body.credentials_status).toBe('needs_reconnect')

      const row = db.prepare('SELECT credentials, credentials_status FROM sources WHERE id = ?').get(disconnectSourceId) as any
      expect(row.credentials).toBeNull()
      expect(row.credentials_status).toBe('needs_reconnect')

      const book = db.prepare('SELECT status FROM books WHERE id = ?').get(activeBookId) as any
      expect(book.status).toBe('missing')
    })

    it('404s for a nonexistent source', async () => {
      const res = await request(app)
        .post('/api/sources/does-not-exist/disconnect')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(404)
    })

    it('400s for a local source', async () => {
      const res = await request(app)
        .post(`/api/sources/${sourceId}/disconnect`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(400)
    })

    it('is safe to call twice', async () => {
      const { getDb } = await import('../src/db/index.js')
      const { encryptCredentials } = await import('../src/integrations/remote/credentials.js')
      const { randomUUID } = await import('node:crypto')
      const db = getDb()

      const twiceSourceId = randomUUID()
      db.prepare(
        `INSERT INTO sources (id, type, label, path_scope, credentials, credentials_status)
         VALUES (?, 'google_drive', 'Disconnect Twice', 'some-folder-id', ?, 'ok')`,
      ).run(twiceSourceId, encryptCredentials({ accessToken: 'a', refreshToken: 'r' }))

      const first = await request(app)
        .post(`/api/sources/${twiceSourceId}/disconnect`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(first.status).toBe(200)

      const second = await request(app)
        .post(`/api/sources/${twiceSourceId}/disconnect`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(second.status).toBe(200)
      expect(second.body.credentials_status).toBe('needs_reconnect')
    })
  })
})

describe('GET/PATCH /api/settings', () => {
  it('returns the singleton settings row with sane defaults', async () => {
    const res = await request(app).get('/api/settings').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(200)
    expect(typeof res.body.nightly_rescan_enabled).toBe('boolean')
    expect(typeof res.body.nightly_rescan_time).toBe('string')
  })

  it('updates in place and only touches the fields sent', async () => {
    const before = await request(app).get('/api/settings').set('Authorization', `Bearer ${TEST_TOKEN}`)

    const enableRes = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ nightlyRescanEnabled: true })
    expect(enableRes.status).toBe(200)
    expect(enableRes.body.nightly_rescan_enabled).toBe(true)
    expect(enableRes.body.nightly_rescan_time).toBe(before.body.nightly_rescan_time)

    const timeRes = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ nightlyRescanTime: '03:30' })
    expect(timeRes.status).toBe(200)
    expect(timeRes.body.nightly_rescan_time).toBe('03:30')
    // Not sent this time — should still be true from the previous PATCH.
    expect(timeRes.body.nightly_rescan_enabled).toBe(true)
  })
})

describe('PATCH /api/books/:id and series-number backfill', () => {
  it('sets series name/number and locks the source to manual', async () => {
    const res = await request(app)
      .patch(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ seriesName: 'Manual Series', seriesNumber: 5 })
    expect(res.status).toBe(200)
    expect(res.body.series_name).toBe('Manual Series')
    expect(res.body.series_number).toBe(5)
    expect(res.body.series_number_source).toBe('manual')
  })

  it('un-locks the series number when explicitly cleared back to null', async () => {
    await request(app)
      .patch(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ seriesNumber: 7 })

    const res = await request(app)
      .patch(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ seriesNumber: null })
    expect(res.status).toBe(200)
    expect(res.body.series_number).toBeNull()
    expect(res.body.series_number_source).toBeNull()
  })

  it('leaves fields not present in the body untouched', async () => {
    await request(app)
      .patch(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ seriesName: 'Untouched Series', seriesNumber: 1 })

    const res = await request(app).patch(`/api/books/${bookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.series_name).toBe('Untouched Series')
    expect(res.body.series_number).toBe(1)
  })

  it('404s for a nonexistent book', async () => {
    const res = await request(app)
      .patch('/api/books/does-not-exist')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ seriesNumber: 1 })
    expect(res.status).toBe(404)
  })

  it('backfill fills a gap and leaves an already-numbered book untouched', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { randomUUID } = await import('node:crypto')
    const db = getDb()

    const gapBookId = randomUUID()
    db.prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, series_name, series_number, status)
       VALUES (?, ?, 'gap-book-path', 'm4b', 'Gap Book', 'Backfill Series', NULL, 'active')`,
    ).run(gapBookId, sourceId)

    const alreadyNumberedId = randomUUID()
    db.prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, series_name, series_number, series_number_source, status)
       VALUES (?, ?, 'already-numbered-path', 'm4b', 'Already Numbered', 'Backfill Series', 42, 'tag', 'active')`,
    ).run(alreadyNumberedId, sourceId)

    // "gap-book-path" has no leading/echoed number for the heuristic to
    // find — update it to something the folder-name heuristic can read.
    db.prepare('UPDATE books SET file_path = ? WHERE id = ?').run(
      'Backfill Series/Backfill Series 4 - Gap Book',
      gapBookId,
    )

    const res = await request(app)
      .post('/api/books/backfill-series-numbers')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body.attempted).toBeGreaterThanOrEqual(1)

    const gapBook = db.prepare('SELECT * FROM books WHERE id = ?').get(gapBookId) as any
    expect(gapBook.series_number).toBe(4)
    expect(gapBook.series_number_source).toBe('folder')

    const alreadyNumbered = db.prepare('SELECT * FROM books WHERE id = ?').get(alreadyNumberedId) as any
    expect(alreadyNumbered.series_number).toBe(42) // untouched
    expect(alreadyNumbered.series_number_source).toBe('tag')
  })
})
