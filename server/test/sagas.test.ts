import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'

// Direct DB inserts, not a real scan — same lighter-weight pattern as
// companionLink.test.ts. sagas.ts only cares that a series_name string has
// at least one book, not how that book was ingested.
const TEST_TOKEN = 'test-token-sagas'
let app: import('express').Express

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-sagas-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  process.env.OZZBOOKS_API_TOKEN = TEST_TOKEN

  const { getDb } = await import('../src/db/index.js')
  const sourceId = randomUUID()
  getDb()
    .prepare("INSERT INTO sources (id, type, label, path_scope) VALUES (?, 'local', 'Test Source', '/test')")
    .run(sourceId)

  function insertBook(seriesName: string, title: string) {
    getDb()
      .prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, series_name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'm4b', ?, ?, 'active', datetime('now'), datetime('now'))`,
      )
      .run(randomUUID(), sourceId, `/test/${title}.m4b`, title, seriesName)
  }
  insertBook('Mistborn', 'The Final Empire')
  insertBook('Elantris', 'Elantris')
  insertBook('Warbreaker', 'Warbreaker')

  const { createApp } = await import('../src/api/app.js')
  app = createApp()
}, 30_000)

function auth(req: request.Test) {
  return req.set('Authorization', `Bearer ${TEST_TOKEN}`)
}

describe('sagas API', () => {
  it('lists no sagas before any series has been added', async () => {
    const res = await auth(request(app).get('/api/sagas'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('returns an empty series list for a saga name that has no rows yet, not a 404', async () => {
    const res = await auth(request(app).get('/api/sagas/Cosmere'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ saga_name: 'Cosmere', series: [] })
  })

  it('rejects adding a series that has no books', async () => {
    const res = await auth(request(app).post('/api/sagas/Cosmere/series').send({ seriesName: 'Not A Real Series' }))
    expect(res.status).toBe(400)
  })

  it('adds series to a saga in append order, then lists it', async () => {
    const add1 = await auth(request(app).post('/api/sagas/Cosmere/series').send({ seriesName: 'Mistborn' }))
    expect(add1.status).toBe(200)
    expect(add1.body.series).toEqual([{ series_name: 'Mistborn', position: 0 }])

    const add2 = await auth(request(app).post('/api/sagas/Cosmere/series').send({ seriesName: 'Elantris' }))
    expect(add2.status).toBe(200)
    expect(add2.body.series).toEqual([
      { series_name: 'Mistborn', position: 0 },
      { series_name: 'Elantris', position: 1 },
    ])

    const list = await auth(request(app).get('/api/sagas'))
    expect(list.body).toEqual([{ saga_name: 'Cosmere', series_count: 2 }])
  })

  it('moves a series from one saga to another instead of erroring (a series belongs to at most one saga)', async () => {
    await auth(request(app).post('/api/sagas/Other Saga/series').send({ seriesName: 'Elantris' }))

    const cosmere = await auth(request(app).get('/api/sagas/Cosmere'))
    expect(cosmere.body.series).toEqual([{ series_name: 'Mistborn', position: 0 }])

    const other = await auth(request(app).get('/api/sagas/Other Saga'))
    expect(other.body.series).toEqual([{ series_name: 'Elantris', position: 0 }])
  })

  it('reorders a saga\'s series via a full-list replace', async () => {
    await auth(request(app).post('/api/sagas/Cosmere/series').send({ seriesName: 'Warbreaker' }))
    // Now Cosmere = [Mistborn(0), Warbreaker(1)] — flip them.
    const res = await auth(
      request(app)
        .put('/api/sagas/Cosmere/series')
        .send({ seriesNames: ['Warbreaker', 'Mistborn'] }),
    )
    expect(res.status).toBe(200)
    expect(res.body.series).toEqual([
      { series_name: 'Warbreaker', position: 0 },
      { series_name: 'Mistborn', position: 1 },
    ])
  })

  it('rejects a reorder whose series set does not match the saga\'s current members', async () => {
    const res = await auth(
      request(app)
        .put('/api/sagas/Cosmere/series')
        .send({ seriesNames: ['Mistborn'] }), // missing Warbreaker
    )
    expect(res.status).toBe(400)
  })

  it('removes one series from a saga, without renumbering the rest (gaps are fine)', async () => {
    const res = await auth(request(app).delete('/api/sagas/Cosmere/series/Warbreaker'))
    expect(res.status).toBe(204)

    const detail = await auth(request(app).get('/api/sagas/Cosmere'))
    expect(detail.body.series).toEqual([{ series_name: 'Mistborn', position: 1 }])
  })

  it('renames a saga', async () => {
    const res = await auth(request(app).patch('/api/sagas/Other Saga').send({ sagaName: 'Renamed Saga' }))
    expect(res.status).toBe(200)
    expect(res.body.saga_name).toBe('Renamed Saga')

    const old = await auth(request(app).get('/api/sagas/Other Saga'))
    expect(old.body.series).toEqual([])
  })

  it('deletes a whole saga without touching the underlying books', async () => {
    const res = await auth(request(app).delete('/api/sagas/Renamed Saga'))
    expect(res.status).toBe(204)

    const detail = await auth(request(app).get('/api/sagas/Renamed Saga'))
    expect(detail.body.series).toEqual([])

    const books = await auth(request(app).get('/api/books'))
    expect(books.body.some((b: { title: string }) => b.title === 'Elantris')).toBe(true)
  })

  it('surfaces saga membership on the books list and detail endpoints', async () => {
    const books = await auth(request(app).get('/api/books'))
    const mistborn = books.body.find((b: { title: string }) => b.title === 'The Final Empire')
    expect(mistborn.saga_name).toBe('Cosmere')
    expect(mistborn.saga_position).toBe(1)

    const detail = await auth(request(app).get(`/api/books/${mistborn.id}`))
    expect(detail.body.saga_name).toBe('Cosmere')
    expect(detail.body.saga_position).toBe(1)
  })

  it('requires auth, same as every other /api route', async () => {
    const res = await request(app).get('/api/sagas')
    expect(res.status).toBe(401)
  })
})
