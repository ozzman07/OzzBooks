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

  describe('GET /api/books?status= and DELETE /api/books/:id', () => {
    let missingBookId: string

    it('inserts a directly-crafted missing book for these tests to target', async () => {
      const { getDb } = await import('../src/db/index.js')
      const { randomUUID } = await import('node:crypto')
      missingBookId = randomUUID()
      getDb()
        .prepare(
          `INSERT INTO books (id, source_id, file_path, format, title, author, status)
           VALUES (?, ?, '/nowhere/Gone Book.m4b', 'm4b', 'Gone Book', 'Some Author', 'missing')`,
        )
        .run(missingBookId, sourceId)
    })

    it('?status=missing returns only the missing book', async () => {
      const res = await request(app).get('/api/books?status=missing').set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.body.map((b: any) => b.id)).toEqual([missingBookId])
    })

    it('?status=active excludes the missing book', async () => {
      const [activeRes, allRes] = await Promise.all([
        request(app).get('/api/books?status=active').set('Authorization', `Bearer ${TEST_TOKEN}`),
        request(app).get('/api/books').set('Authorization', `Bearer ${TEST_TOKEN}`),
      ])
      expect(activeRes.status).toBe(200)
      expect(activeRes.body.some((b: any) => b.id === missingBookId)).toBe(false)
      // One less than the unfiltered total (this file also inserts its own
      // extra active book in an earlier test, so an exact count here would
      // be fragile to that shared state) — the missing book is the only one
      // status=active should be excluding.
      expect(activeRes.body).toHaveLength(allRes.body.length - 1)
    })

    it('with no status filter, returns both active and missing books', async () => {
      const res = await request(app).get('/api/books').set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.body.some((b: any) => b.id === missingBookId)).toBe(true)
    })

    it('refuses to delete an active book', async () => {
      const res = await request(app).delete(`/api/books/${bookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(400)

      const stillThere = await request(app).get(`/api/books/${bookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(stillThere.status).toBe(200)
    })

    it('deletes a missing book and logs the removal', async () => {
      const res = await request(app).delete(`/api/books/${missingBookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })

      const gone = await request(app).get(`/api/books/${missingBookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(gone.status).toBe(404)

      const { getDb } = await import('../src/db/index.js')
      const logEntry = getDb()
        .prepare("SELECT * FROM activity_log WHERE book_id = ? AND action = 'removed'")
        .get(missingBookId) as any
      expect(logEntry).toBeTruthy()
      expect(logEntry.detail).toContain('Manually removed')
    })
  })

  describe('companion linking routes', () => {
    let audioBookId: string
    let epubBookId: string
    let otherEpubBookId: string

    it('inserts a directly-crafted audiobook + two candidate epubs for these tests to target', async () => {
      const { getDb } = await import('../src/db/index.js')
      const { randomUUID } = await import('node:crypto')
      audioBookId = randomUUID()
      epubBookId = randomUUID()
      otherEpubBookId = randomUUID()
      const db = getDb()
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, author, status)
         VALUES (?, ?, '/companion/Author Co/Companion Book.m4b', 'm4b', 'Companion Book', 'Author Co', 'active')`,
      ).run(audioBookId, sourceId)
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, author, status)
         VALUES (?, ?, '/companion/Author Co/Companion Book.epub', 'epub', 'Companion Book', 'Author Co', 'active')`,
      ).run(epubBookId, sourceId)
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, author, status)
         VALUES (?, ?, '/companion/Someone/Unrelated.epub', 'epub', 'Unrelated', 'Someone', 'active')`,
      ).run(otherEpubBookId, sourceId)
    })

    it('suggests the matching epub as the top companion candidate', async () => {
      const res = await request(app)
        .get(`/api/books/${audioBookId}/companion-candidates`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.body[0].id).toBe(epubBookId)
      expect(res.body.some((c: any) => c.id === otherEpubBookId)).toBe(true) // still listed, just lower-ranked
    })

    it('refuses to link two books of the same "side" (both audio, or both ebook)', async () => {
      const res = await request(app)
        .post(`/api/books/${epubBookId}/link-companion`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({ targetBookId: otherEpubBookId })
      expect(res.status).toBe(400)
    })

    it('links a book to its companion and logs it', async () => {
      const res = await request(app)
        .post(`/api/books/${audioBookId}/link-companion`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({ targetBookId: epubBookId })
      expect(res.status).toBe(200)
      expect(res.body.companion_book_id).toBe(epubBookId)

      const epubRes = await request(app).get(`/api/books/${epubBookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(epubRes.body.companion_book_id).toBe(audioBookId)

      const { getDb } = await import('../src/db/index.js')
      const log = getDb()
        .prepare("SELECT * FROM activity_log WHERE book_id = ? AND action = 'metadata_updated'")
        .get(audioBookId) as any
      expect(log.detail).toContain('Manually linked')
    })

    it('now excludes the linked epub from candidate suggestions for other books', async () => {
      const res = await request(app)
        .get(`/api/books/${otherEpubBookId}/companion-candidates`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      // audioBookId already has a companion (epubBookId), so it shouldn't be suggested here.
      expect(res.status).toBe(200)
      expect(res.body.some((c: any) => c.id === audioBookId)).toBe(false)
    })

    it('unlinks a companion pair', async () => {
      const res = await request(app)
        .post(`/api/books/${audioBookId}/unlink-companion`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.body.companion_book_id).toBeNull()

      const epubRes = await request(app).get(`/api/books/${epubBookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(epubRes.body.companion_book_id).toBeNull()
    })

    it('404s linking a nonexistent book, 400s a missing targetBookId', async () => {
      const notFound = await request(app)
        .post('/api/books/does-not-exist/link-companion')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({ targetBookId: epubBookId })
      expect(notFound.status).toBe(404)

      const badRequest = await request(app)
        .post(`/api/books/${audioBookId}/link-companion`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({})
      expect(badRequest.status).toBe(400)
    })
  })

  describe('GET /api/books/:id/epub', () => {
    let realEpubBookId: string
    let audioLinkedToEpubId: string
    let audioWithNoEpubId: string

    it('sets up a real epub file on disk, an audiobook linked to it, and an audiobook with no ebook at all', async () => {
      const { getDb } = await import('../src/db/index.js')
      const { randomUUID } = await import('node:crypto')
      const { mkdtemp } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const path = await import('node:path')
      const { makeTestEpub } = await import('./fixtures.js')

      const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-epub-serve-'))
      const epubPath = path.join(dir, 'Real Book.epub')
      await makeTestEpub(epubPath, { title: 'Real Book', author: 'Real Author' })

      const db = getDb()
      realEpubBookId = randomUUID()
      audioLinkedToEpubId = randomUUID()
      audioWithNoEpubId = randomUUID()
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, author, status)
         VALUES (?, ?, ?, 'epub', 'Real Book', 'Real Author', 'active')`,
      ).run(realEpubBookId, sourceId, epubPath)
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, author, status, companion_book_id)
         VALUES (?, ?, '/nowhere/audio.m4b', 'm4b', 'Real Book', 'Real Author', 'active', ?)`,
      ).run(audioLinkedToEpubId, sourceId, realEpubBookId)
      db.prepare("UPDATE books SET companion_book_id = ? WHERE id = ?").run(audioLinkedToEpubId, realEpubBookId)
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, author, status)
         VALUES (?, ?, '/nowhere/lonely.m4b', 'm4b', 'Lonely Book', 'Lonely Author', 'active')`,
      ).run(audioWithNoEpubId, sourceId)
    })

    it('serves the epub bytes directly for an epub-primary book', async () => {
      const res = await request(app).get(`/api/books/${realEpubBookId}/epub`).set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('application/epub+zip')
      // supertest/superagent doesn't have a built-in parser for
      // application/epub+zip, so the raw bytes land in res.text rather
      // than a parsed res.body — just confirming real content came back.
      expect(res.text.length).toBeGreaterThan(0)
    })

    it("serves the linked companion's epub for an audiobook", async () => {
      const res = await request(app)
        .get(`/api/books/${audioLinkedToEpubId}/epub`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('application/epub+zip')
    })

    it('404s for an audiobook with no linked ebook', async () => {
      const res = await request(app)
        .get(`/api/books/${audioWithNoEpubId}/epub`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/books/:id/pages/:index', () => {
    let comicBookId: string
    let audioBookId: string

    it('sets up a real .cbz file on disk and an audiobook for the not-a-comic case', async () => {
      const { getDb } = await import('../src/db/index.js')
      const { randomUUID } = await import('node:crypto')
      const { mkdtemp } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const path = await import('node:path')
      const { makeTestComic } = await import('./fixtures.js')

      const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-serve-'))
      const cbzPath = path.join(dir, 'Real Comic.cbz')
      // Natural-sort order matters here: page10 must land at index 2, not
      // index 1 (a plain lexical sort would put it right after page1).
      await makeTestComic(cbzPath, { pages: ['page1.jpg', 'page2.png', 'page10.jpg'], comicInfo: null })

      const db = getDb()
      comicBookId = randomUUID()
      audioBookId = randomUUID()
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, status, page_count)
         VALUES (?, ?, ?, 'cbz', 'Real Comic', 'active', 3)`,
      ).run(comicBookId, sourceId, cbzPath)
      db.prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, status)
         VALUES (?, ?, '/nowhere/audio.m4b', 'm4b', 'Not A Comic', 'active')`,
      ).run(audioBookId, sourceId)
    })

    it('serves page 0 with the right content-type and bytes', async () => {
      const res = await request(app)
        .get(`/api/books/${comicBookId}/pages/0`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('image/jpeg')
      expect(res.body.toString()).toBe('page-content-page1.jpg')
    })

    it('serves a later page in natural-sorted (not lexical) order, with its own content-type', async () => {
      const res = await request(app)
        .get(`/api/books/${comicBookId}/pages/1`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('image/png')
      expect(res.body.toString()).toBe('page-content-page2.png')

      const lastRes = await request(app)
        .get(`/api/books/${comicBookId}/pages/2`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(lastRes.status).toBe(200)
      expect(lastRes.body.toString()).toBe('page-content-page10.jpg')
    })

    it('404s for an out-of-range page index', async () => {
      const res = await request(app)
        .get(`/api/books/${comicBookId}/pages/99`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(404)
    })

    it('400s for a non-numeric page index', async () => {
      const res = await request(app)
        .get(`/api/books/${comicBookId}/pages/not-a-number`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(400)
    })

    it('404s for a book that is not a comic', async () => {
      const res = await request(app)
        .get(`/api/books/${audioBookId}/pages/0`)
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
      expect(res.status).toBe(404)
    })
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
    expect(res.body.auto_purge_enabled).toBe(true) // on by default
    expect(res.body.auto_purge_after_days).toBe(60)
  })

  it('updates auto-purge settings independently of the nightly rescan ones', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ autoPurgeEnabled: false, autoPurgeAfterDays: 30 })
    expect(res.status).toBe(200)
    expect(res.body.auto_purge_enabled).toBe(false)
    expect(res.body.auto_purge_after_days).toBe(30)

    // Re-enable so this doesn't leak into other tests in this shared-DB file.
    await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .send({ autoPurgeEnabled: true, autoPurgeAfterDays: 60 })
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

    const { getDb } = await import('../src/db/index.js')
    const logEntry = getDb().prepare("SELECT * FROM activity_log WHERE book_id = ? AND action = 'series_updated'").get(bookId) as any
    expect(logEntry).toBeTruthy()
    expect(logEntry.detail).toContain('Manual Series')
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

    const { getDb } = await import('../src/db/index.js')
    const logCountBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM activity_log WHERE book_id = ?').get(bookId) as any).n

    const res = await request(app).patch(`/api/books/${bookId}`).set('Authorization', `Bearer ${TEST_TOKEN}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.series_name).toBe('Untouched Series')
    expect(res.body.series_number).toBe(1)

    // A no-op PATCH (nothing in the body, everything left as-is) must not
    // log a phantom "series_updated" event.
    const logCountAfter = (getDb().prepare('SELECT COUNT(*) AS n FROM activity_log WHERE book_id = ?').get(bookId) as any).n
    expect(logCountAfter).toBe(logCountBefore)
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
