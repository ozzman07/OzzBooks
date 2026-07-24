import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const TEST_TOKEN = 'test-token-enrichment'

vi.mock('../src/ingestion/enrichment/openLibrary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ingestion/enrichment/openLibrary.js')>()
  return {
    ...actual,
    searchWork: vi.fn().mockResolvedValue(null),
    fetchCover: vi.fn(),
  }
})

let app: import('express').Express

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-enrichment-api-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  process.env.OZZBOOKS_API_TOKEN = TEST_TOKEN

  const { createApp } = await import('../src/api/app.js')
  app = createApp()
}, 30_000)

describe('enrichment routes', () => {
  it('requires the app token', async () => {
    const res = await request(app).post('/api/enrichment/start')
    expect(res.status).toBe(401)
  })

  it('starts a pass and reports status via polling', async () => {
    const startRes = await request(app).post('/api/enrichment/start').set('Authorization', `Bearer ${TEST_TOKEN}`)
    expect(startRes.status).toBe(202)
    expect(['running', 'completed']).toContain(startRes.body.status) // may finish instantly with zero candidate books

    let statusRes: any
    for (let i = 0; i < 50; i++) {
      statusRes = await request(app).get('/api/enrichment/status').set('Authorization', `Bearer ${TEST_TOKEN}`)
      if (statusRes.body.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(statusRes.body.status).toBe('completed')
    expect(statusRes.body.result).toEqual({
      attempted: 0,
      genreUpdated: 0,
      synopsisUpdated: 0,
      coverUpdated: 0,
      skipped: 0,
      failed: 0,
      abortedDueToUnavailability: false,
    })
  })
})
