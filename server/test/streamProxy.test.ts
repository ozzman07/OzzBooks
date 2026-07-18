import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createReadStream, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { RemoteProvider } from '../src/integrations/remote/types.js'

let dataDir: string
let app: import('express').Express
let fileServer: { url: string; close: () => Promise<void> }
let filePath: string
let fileBytes: Buffer

const TEST_TOKEN = 'test-token-stream-proxy'

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-streamproxy-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  process.env.OZZBOOKS_API_TOKEN = TEST_TOKEN

  // A real file served with real Range support — stands in for Drive's
  // alt=media endpoint, so the proxy's fetch/pipe/header-forwarding logic
  // runs against a real HTTP round-trip rather than mocks.
  const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-streamproxy-file-'))
  filePath = path.join(dir, 'audio.bin')
  fileBytes = Buffer.from('x'.repeat(5000))
  writeFileSync(filePath, fileBytes)

  fileServer = await new Promise((resolve) => {
    const { size } = statSync(filePath)
    const server: Server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer fake-drive-token') // proves headers reach the upstream
      const range = req.headers.range
      if (range) {
        const match = /bytes=(\d+)-(\d+)?/.exec(range)!
        const start = Number(match[1])
        const end = match[2] ? Number(match[2]) : size - 1
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' })
        createReadStream(filePath, { start, end }).pipe(res)
      } else {
        res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
        createReadStream(filePath).pipe(res)
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ url: `http://127.0.0.1:${port}/f`, close: () => new Promise((res) => server.close(() => res())) })
    })
  })

  const fakeProvider: RemoteProvider = {
    type: 'google_drive',
    refreshToken: async (c) => c,
    ensureManagedFolder: async () => ({ folderId: 'x' }),
    listTree: async () => [],
    getMetadataAccess: async () => ({ url: fileServer.url, headers: { Authorization: 'Bearer fake-drive-token' } }),
  }

  const { registerProvider } = await import('../src/integrations/remote/registry.js')
  registerProvider(fakeProvider)

  const { createApp } = await import('../src/api/app.js')
  app = createApp()
}, 30_000)

afterAll(async () => {
  await fileServer.close()
})

async function insertRemoteSourceAndChapter() {
  const { getDb } = await import('../src/db/index.js')
  const { encryptCredentials } = await import('../src/integrations/remote/credentials.js')
  const db = getDb()

  const sourceId = randomUUID()
  db.prepare(
    `INSERT INTO sources (id, type, label, path_scope, credentials, credentials_expires_at, credentials_status)
     VALUES (?, 'google_drive', 'Test Drive', 'root', ?, ?, 'ok')`,
  ).run(sourceId, encryptCredentials({ accessToken: 'a', refreshToken: 'r' }), new Date(Date.now() + 3600_000).toISOString())

  const bookId = randomUUID()
  db.prepare(
    `INSERT INTO books (id, source_id, file_path, format, title, status) VALUES (?, ?, 'gdrive://fake-id', 'm4b', 'Remote Book', 'active')`,
  ).run(bookId, sourceId)

  const chapterId = randomUUID()
  db.prepare(
    `INSERT INTO chapters (id, book_id, idx, title, start_time, duration, file_path) VALUES (?, ?, 0, 'Ch1', 0, 100, 'gdrive://fake-id')`,
  ).run(chapterId, bookId)

  return chapterId
}

describe('proxyRemoteStream (real HTTP round-trip through the proxy)', () => {
  it('streams a full file through with the right content type and forwarded auth', async () => {
    const chapterId = await insertRemoteSourceAndChapter()
    const res = await request(app).get(`/api/chapters/${chapterId}/stream`).set('Authorization', `Bearer ${TEST_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('audio/mp4')
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(Buffer.from(res.body).length || res.text.length).toBeGreaterThan(0)
  })

  it('forwards a Range request and returns a real 206 partial response', async () => {
    const chapterId = await insertRemoteSourceAndChapter()
    const res = await request(app)
      .get(`/api/chapters/${chapterId}/stream`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .set('Range', 'bytes=10-19')

    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 10-19/${fileBytes.length}`)
    const body = Buffer.isBuffer(res.body) && res.body.length > 0 ? res.body : Buffer.from(res.text)
    expect(body.length).toBe(10)
    expect(body.toString()).toBe(fileBytes.subarray(10, 20).toString())
  })
})
