import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestLibrary, type TestLibrary } from './fixtures.js'
import type { RemoteEntry, RemoteProvider } from '../src/integrations/remote/types.js'

function serveFileWithRanges(filePath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const { size } = statSync(filePath)
  const server: Server = createServer((req, res) => {
    const range = req.headers.range
    if (range) {
      const match = /bytes=(\d+)-(\d+)?/.exec(range)
      const start = Number(match![1])
      const end = match![2] ? Number(match![2]) : size - 1
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' })
      createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
      if (req.method === 'HEAD') res.end()
      else createReadStream(filePath).pipe(res)
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ url: `http://127.0.0.1:${port}/f`, close: () => new Promise((res) => server.close(() => res())) })
    })
  })
}

/** A fake provider backed by a scripted RemoteEntry[] tree and real local
 * HTTP servers for whichever files a test actually wants parsed — lets
 * remoteScan.ts's real discovery/hashing/parsing/DB-write logic run
 * against real audio bytes without needing live Drive credentials. */
function makeFakeProvider(entries: RemoteEntry[], fileServers: Map<string, string>): RemoteProvider {
  return {
    type: 'google_drive',
    refreshToken: async (c) => c,
    ensureManagedFolder: async () => ({ folderId: 'root' }),
    listTree: async () => entries,
    getMetadataAccess: async (_source, _credentials, fileId) => {
      const url = fileServers.get(fileId)
      if (!url) throw new Error(`no fake server registered for file id ${fileId}`)
      return { url, headers: {} }
    },
  }
}

let library: TestLibrary
let dataDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-remotescan-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
  library = await buildTestLibrary()
}, 30_000)

async function insertSource(overrides: Partial<{ credentialsStatus: string }> = {}) {
  const { getDb } = await import('../src/db/index.js')
  const { encryptCredentials } = await import('../src/integrations/remote/credentials.js')
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO sources (id, type, label, path_scope, credentials, credentials_expires_at, credentials_status)
     VALUES (?, 'google_drive', 'Test Drive', 'root', ?, ?, ?)`,
  ).run(
    id,
    encryptCredentials({ accessToken: 'fake-token', refreshToken: 'fake-refresh' }),
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    overrides.credentialsStatus ?? 'ok',
  )
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as any
}

describe('scanGoogleDriveSource', () => {
  it('discovers an m4b book and an mp3-folder book, deriving author/series from the folder tree, excluding a "To Delete" decoy', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanGoogleDriveSource } = await import(
      '../src/integrations/remote/googleDrive/remoteScan.js'
    )

    const m4bServer = await serveFileWithRanges(library.m4bPath)
    const mp3Files = [
      { name: '01 - Chapter One.mp3', path: path.join(library.mp3FolderDir, '01 - Chapter One.mp3') },
      { name: '02 - Chapter Two.mp3', path: path.join(library.mp3FolderDir, '02 - Chapter Two.mp3') },
      { name: '03 - Chapter Three.mp3', path: path.join(library.mp3FolderDir, '03 - Chapter Three.mp3') },
    ]
    const mp3Servers = await Promise.all(mp3Files.map((f) => serveFileWithRanges(f.path)))
    const decoyServer = await serveFileWithRanges(library.sourceBackupFilePath) // reused as a stand-in corrupt/irrelevant file

    try {
      const fileServers = new Map<string, string>([
        ['m4b-file-id', m4bServer.url],
        ...mp3Files.map((_, i): [string, string] => [`mp3-file-${i}`, mp3Servers[i].url]),
        ['decoy-file-id', decoyServer.url],
      ])

      const entries: RemoteEntry[] = [
        { id: 'author-folder', name: 'Brandon Sanderson', parentId: null, kind: 'folder' },
        { id: 'series-folder', name: 'Mistborn Series', parentId: 'author-folder', kind: 'folder' },
        { id: 'book-folder', name: 'The Final Empire', parentId: 'series-folder', kind: 'folder' },
        {
          id: 'm4b-file-id',
          name: 'book.m4b',
          parentId: 'book-folder',
          kind: 'file',
          extension: '.m4b',
          size: statSync(library.m4bPath).size,
        },

        { id: 'author2-folder', name: 'Andy Weir', parentId: null, kind: 'folder' },
        { id: 'mp3-book-folder', name: 'Project Hail Mary', parentId: 'author2-folder', kind: 'folder' },
        ...mp3Files.map((f, i) => ({
          id: `mp3-file-${i}`,
          name: f.name,
          parentId: 'mp3-book-folder',
          kind: 'file' as const,
          extension: '.mp3',
          size: statSync(f.path).size,
        })),

        // A "To Delete" backup folder — its contents must be excluded
        // entirely, same as the local ingestion behavior it mirrors.
        { id: 'to-delete-folder', name: 'To Delete', parentId: 'book-folder', kind: 'folder' },
        {
          id: 'decoy-file-id',
          name: 'old-copy.m4b',
          parentId: 'to-delete-folder',
          kind: 'file',
          extension: '.m4b',
          size: statSync(library.sourceBackupFilePath).size,
        },
      ]

      const provider = makeFakeProvider(entries, fileServers)
      const source = await insertSource()

      const result = await scanGoogleDriveSource(source, provider)

      expect(result.found).toBe(2) // the m4b + the mp3-folder — NOT the "To Delete" decoy
      expect(result.created).toBe(2)
      expect(result.failed).toBe(0)

      const books = getDb().prepare('SELECT * FROM books WHERE source_id = ? ORDER BY title').all(source.id) as any[]
      expect(books).toHaveLength(2)

      const m4bBook = books.find((b) => b.format === 'm4b')
      expect(m4bBook.title).toBe('Mistborn: The Final Empire')
      expect(m4bBook.author).toBe('Brandon Sanderson')
      expect(m4bBook.series_name).toBe('Mistborn Series')
      expect(m4bBook.file_path).toBe('gdrive://m4b-file-id')

      const m4bChapters = getDb().prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(m4bBook.id) as any[]
      expect(m4bChapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter One'])

      const mp3Book = books.find((b) => b.format === 'mp3_folder')
      expect(mp3Book.title).toBe('Project Hail Mary')
      expect(mp3Book.author).toBe('Andy Weir')
      expect(mp3Book.series_name).toBeNull() // directly under author, no series layer
      expect(mp3Book.file_path).toBe('gdrive-folder://mp3-book-folder')

      const mp3Chapters = getDb().prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(mp3Book.id) as any[]
      expect(mp3Chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three'])

      // Nothing from "To Delete" should exist anywhere.
      const decoyBook = books.find((b) => b.title.includes('old-copy') || b.file_path.includes('decoy'))
      expect(decoyBook).toBeUndefined()
    } finally {
      await Promise.all([m4bServer.close(), ...mp3Servers.map((s) => s.close()), decoyServer.close()])
    }
  }, 30_000)

  it('is idempotent on rescan — same fileId (Drive IDs are stable) updates the same book row, not a duplicate', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanGoogleDriveSource } = await import(
      '../src/integrations/remote/googleDrive/remoteScan.js'
    )

    const server = await serveFileWithRanges(library.folderAuthorBookPath)
    try {
      const entries: RemoteEntry[] = [
        { id: 'author-folder', name: 'Some Author', parentId: null, kind: 'folder' },
        {
          id: 'stable-file-id',
          name: 'book.m4b',
          parentId: 'author-folder',
          kind: 'file',
          extension: '.m4b',
          size: statSync(library.folderAuthorBookPath).size,
        },
      ]
      const provider = makeFakeProvider(entries, new Map([['stable-file-id', server.url]]))
      const source = await insertSource()

      const first = await scanGoogleDriveSource(source, provider)
      expect(first.created).toBe(1)
      const bookBefore = getDb().prepare('SELECT * FROM books WHERE source_id = ?').get(source.id) as any

      const second = await scanGoogleDriveSource(source, provider)
      expect(second.created).toBe(0)
      expect(second.updated).toBe(1)

      const books = getDb().prepare('SELECT * FROM books WHERE source_id = ?').all(source.id) as any[]
      expect(books).toHaveLength(1)
      expect(books[0].id).toBe(bookBefore.id)
    } finally {
      await server.close()
    }
  }, 30_000)

  it('short-circuits to marking books missing when credentials_status is needs_reconnect, without calling listTree', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanGoogleDriveSource } = await import(
      '../src/integrations/remote/googleDrive/remoteScan.js'
    )

    const source = await insertSource({ credentialsStatus: 'needs_reconnect' })
    const bookId = randomUUID()
    getDb()
      .prepare(
        `INSERT INTO books (id, source_id, file_path, format, title, status) VALUES (?, ?, 'gdrive://x', 'm4b', 'Revoked Book', 'active')`,
      )
      .run(bookId, source.id)

    let listTreeCalled = false
    const provider: RemoteProvider = {
      type: 'google_drive',
      refreshToken: async (c) => c,
      ensureManagedFolder: async () => ({ folderId: 'x' }),
      listTree: async () => {
        listTreeCalled = true
        return []
      },
      getMetadataAccess: async () => ({ url: '', headers: {} }),
    }

    const result = await scanGoogleDriveSource(source, provider)
    expect(listTreeCalled).toBe(false)
    expect(result.markedMissing).toBe(1)

    const book = getDb().prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any
    expect(book.status).toBe('missing')
  })
})

afterAll(() => {})
