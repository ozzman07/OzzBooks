import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestLibrary, makeTone, type TestLibrary } from './fixtures.js'
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

  it('discovers a .m4a file the same as .m4b — same MPEG-4/AAC container, just a different extension', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanGoogleDriveSource } = await import(
      '../src/integrations/remote/googleDrive/remoteScan.js'
    )

    const server = await serveFileWithRanges(library.m4aBookPath)
    try {
      const entries: RemoteEntry[] = [
        { id: 'author-folder', name: 'M4A Author', parentId: null, kind: 'folder' },
        {
          id: 'm4a-file-id',
          name: 'book.m4a',
          parentId: 'author-folder',
          kind: 'file',
          extension: '.m4a',
          size: statSync(library.m4aBookPath).size,
        },
      ]
      const provider = makeFakeProvider(entries, new Map([['m4a-file-id', server.url]]))
      const source = await insertSource()

      const result = await scanGoogleDriveSource(source, provider)
      expect(result.created).toBe(1)
      expect(result.failed).toBe(0)

      const book = getDb().prepare('SELECT * FROM books WHERE source_id = ?').get(source.id) as any
      expect(book.format).toBe('m4b')
      expect(book.title).toBe('M4A Extension Test Book')
      expect(book.author).toBe('M4A Author')
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

// REDESIGNED 2026-09-11 after a real-data incident (see
// ozzbooks-google-drive-chapter-merge-fix memory) — the original "2+ M4B
// files in a folder = one book" rule was too broad and wrongly merged
// folders holding multiple different standalone books. Replaced with two
// narrow filename-pattern checks in partGrouping.ts (unit-tested there
// against every real filename from the incident); these two tests are the
// end-to-end check that discoverCandidates/scanGoogleDriveSource wire that
// logic up correctly, covering both the "should merge" and "should NOT
// merge" real shapes.
describe('scanGoogleDriveSource — chapter-per-file M4B rip in one folder', () => {
  it('merges a folder of single-chapter M4B files sharing a long title prefix, cleaning each chapter title', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanGoogleDriveSource } = await import(
      '../src/integrations/remote/googleDrive/remoteScan.js'
    )

    // Mirrors the real "Going Postal" incident shape: filenames share one
    // long, specific title prefix and differ only in an embedded
    // " - N - <chapter label>" segment; no file has its own internal
    // chapter markers.
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-chapter-rip-'))
    const chapterFiles = [
      { file: 'Going Postal Discworld Book 33 - 01 - Opening Credits.m4b', title: 'Opening Credits' },
      { file: 'Going Postal Discworld Book 33 - 02 - The Prologue.m4b', title: 'The Prologue' },
      { file: 'Going Postal Discworld Book 33 - 03 - Chapter One The Angel.m4b', title: 'Chapter One The Angel' },
    ]
    for (const ch of chapterFiles) {
      await makeTone(path.join(scratchDir, ch.file), 1, [
        '-metadata',
        `title=${ch.title}`,
        '-metadata',
        'artist=Terry Pratchett',
        '-c:a',
        'aac',
      ])
    }

    const servers = await Promise.all(chapterFiles.map((f) => serveFileWithRanges(path.join(scratchDir, f.file))))

    try {
      const fileServers = new Map<string, string>(chapterFiles.map((f, i) => [`chapter-file-${i}`, servers[i].url]))
      const entries: RemoteEntry[] = [
        { id: 'author-folder', name: 'Terry Pratchett', parentId: null, kind: 'folder' },
        { id: 'book-folder', name: 'Going Postal', parentId: 'author-folder', kind: 'folder' },
        ...chapterFiles.map((f, i) => ({
          id: `chapter-file-${i}`,
          name: f.file,
          parentId: 'book-folder',
          kind: 'file' as const,
          extension: '.m4b',
          size: statSync(path.join(scratchDir, f.file)).size,
        })),
      ]

      const provider = makeFakeProvider(entries, fileServers)
      const source = await insertSource()

      const result = await scanGoogleDriveSource(source, provider)

      expect(result.found).toBe(1) // one merged candidate, not three
      expect(result.created).toBe(1)
      expect(result.failed).toBe(0)

      const books = getDb().prepare('SELECT * FROM books WHERE source_id = ?').all(source.id) as any[]
      expect(books).toHaveLength(1)

      const book = books[0]
      expect(book.title).toBe('Going Postal') // folder name, not any single chapter's tag
      expect(book.author).toBe('Terry Pratchett')
      expect(book.file_path).toBe('gdrive://chapter-file-0') // first part, sorted by embedded number

      const chapters = getDb().prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx').all(book.id) as any[]
      expect(chapters).toHaveLength(3)
      expect(chapters.map((c) => c.title)).toEqual(['Opening Credits', 'The Prologue', 'Chapter One The Angel'])
      // Each chapter still points at its own distinct source file.
      expect(new Set(chapters.map((c) => c.file_path)).size).toBe(3)
    } finally {
      await Promise.all(servers.map((s) => s.close()))
    }
  }, 30_000)

  it('strips a "(#N)" folder-name prefix into series_number instead of leaving it stuck on the title', async () => {
    // Real case found in production: an entire Discworld folder tree names
    // each book's own folder "(#N) Title" (e.g. "(#33) Going Postal") —
    // same merged-chapter-rip shape as the test above, just with the
    // book-folder itself carrying a series-index prefix that needs
    // stripping into series_number rather than showing up in the title.
    const { getDb } = await import('../src/db/index.js')
    const { scanGoogleDriveSource } = await import(
      '../src/integrations/remote/googleDrive/remoteScan.js'
    )

    const scratchDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-index-prefix-'))
    const chapterFiles = [
      { file: 'Going Postal Discworld Book 33 - 01 - Opening Credits.m4b', title: 'Opening Credits' },
      { file: 'Going Postal Discworld Book 33 - 02 - The Prologue.m4b', title: 'The Prologue' },
      { file: 'Going Postal Discworld Book 33 - 03 - Chapter One The Angel.m4b', title: 'Chapter One The Angel' },
    ]
    for (const ch of chapterFiles) {
      await makeTone(path.join(scratchDir, ch.file), 1, ['-metadata', `title=${ch.title}`, '-c:a', 'aac'])
    }

    const servers = await Promise.all(chapterFiles.map((f) => serveFileWithRanges(path.join(scratchDir, f.file))))

    try {
      const fileServers = new Map<string, string>(chapterFiles.map((f, i) => [`idx-chapter-file-${i}`, servers[i].url]))
      const entries: RemoteEntry[] = [
        { id: 'idx-author-folder', name: 'Terry Pratchett', parentId: null, kind: 'folder' },
        { id: 'idx-series-folder', name: 'Discworld', parentId: 'idx-author-folder', kind: 'folder' },
        { id: 'idx-book-folder', name: '(#33) Going Postal', parentId: 'idx-series-folder', kind: 'folder' },
        ...chapterFiles.map((f, i) => ({
          id: `idx-chapter-file-${i}`,
          name: f.file,
          parentId: 'idx-book-folder',
          kind: 'file' as const,
          extension: '.m4b',
          size: statSync(path.join(scratchDir, f.file)).size,
        })),
      ]

      const provider = makeFakeProvider(entries, fileServers)
      const source = await insertSource()

      await scanGoogleDriveSource(source, provider)

      const book = getDb().prepare('SELECT * FROM books WHERE source_id = ?').get(source.id) as any
      expect(book.title).toBe('Going Postal') // "(#33)" stripped, not part of the title
      expect(book.series_number).toBe(33)
      expect(book.series_number_source).toBe('folder')

      // A manual correction must still beat the folder prefix on a later
      // rescan — same precedence the local pipeline already guarantees.
      getDb().prepare("UPDATE books SET series_number = 99, series_number_source = 'manual' WHERE id = ?").run(book.id)
      await scanGoogleDriveSource(source, provider)
      const afterRescan = getDb().prepare('SELECT * FROM books WHERE id = ?').get(book.id) as any
      expect(afterRescan.series_number).toBe(99)
      expect(afterRescan.series_number_source).toBe('manual')
    } finally {
      await Promise.all(servers.map((s) => s.close()))
    }
  }, 30_000)

  it('strips a "(#N)" prefix on a single-file M4B book too, not just a merged chapter-rip group', async () => {
    // Real case found in production: not every Discworld book on Drive is
    // a chapter-per-file rip — some are one plain M4B file, still sitting
    // in (and named after) a "(#N) Title" folder (e.g. "(#9) Eric.m4b" in
    // a folder called "(#9) Eric") with no embedded title tag. This never
    // goes through discoverCandidates' folder-based grouping loop at all
    // (single-file candidates keep the file's own name), so the "(#N)"
    // prefix has to be caught centrally, against the final resolved title,
    // not just at the folder-name grouping sites.
    const { getDb } = await import('../src/db/index.js')
    const { scanGoogleDriveSource } = await import(
      '../src/integrations/remote/googleDrive/remoteScan.js'
    )
    const { makeTone } = await import('./fixtures.js')

    const scratchDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-single-index-prefix-'))
    const filePath = path.join(scratchDir, '(#9) Eric.m4b')
    await makeTone(filePath, 1, ['-c:a', 'aac']) // no title tag at all — falls back to the filename

    const server = await serveFileWithRanges(filePath)
    try {
      const entries: RemoteEntry[] = [
        { id: 'single-author-folder', name: 'Terry Pratchett', parentId: null, kind: 'folder' },
        { id: 'single-series-folder', name: 'Discworld', parentId: 'single-author-folder', kind: 'folder' },
        { id: 'single-book-folder', name: '(#9) Eric', parentId: 'single-series-folder', kind: 'folder' },
        {
          id: 'single-file-id',
          name: '(#9) Eric.m4b',
          parentId: 'single-book-folder',
          kind: 'file',
          extension: '.m4b',
          size: statSync(filePath).size,
        },
      ]

      const provider = makeFakeProvider(entries, new Map([['single-file-id', server.url]]))
      const source = await insertSource()

      await scanGoogleDriveSource(source, provider)

      const book = getDb().prepare('SELECT * FROM books WHERE source_id = ?').get(source.id) as any
      expect(book.title).toBe('Eric')
      expect(book.series_number).toBe(9)
      expect(book.series_number_source).toBe('folder')
    } finally {
      await server.close()
    }
  }, 30_000)

  it('does NOT merge a folder of separate standalone books sharing only a short generic prefix (the actual incident shape)', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { scanGoogleDriveSource } = await import(
      '../src/integrations/remote/googleDrive/remoteScan.js'
    )

    // Mirrors the real "Books 1-8" / "Jim Butcher" incident shape: same
    // "prefix - N - suffix" shape as a real chapter rip, but the suffix is
    // a whole different book title each time, and the shared prefix is
    // short — must stay as 3 separate books, not merge.
    const scratchDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-standalone-books-'))
    const bookFiles = [
      { file: 'DCC - 1 - Dungeon Crawler Carl.m4b', title: 'Dungeon Crawler Carl' },
      { file: "DCC - 2 - Carl's Doomsday Scenario.m4b", title: "Carl's Doomsday Scenario" },
      { file: 'DCC - 3 - The Dungeon Anarchists Cookbook.m4b', title: 'The Dungeon Anarchists Cookbook' },
    ]
    for (const b of bookFiles) {
      await makeTone(path.join(scratchDir, b.file), 1, [
        '-metadata',
        `title=${b.title}`,
        '-metadata',
        'artist=Matt Dinniman',
        '-c:a',
        'aac',
      ])
    }

    const servers = await Promise.all(bookFiles.map((f) => serveFileWithRanges(path.join(scratchDir, f.file))))

    try {
      const fileServers = new Map<string, string>(bookFiles.map((f, i) => [`book-file-${i}`, servers[i].url]))
      const entries: RemoteEntry[] = [
        { id: 'author-folder', name: 'Matt Dinniman', parentId: null, kind: 'folder' },
        { id: 'series-folder', name: 'Books 1-8', parentId: 'author-folder', kind: 'folder' },
        ...bookFiles.map((f, i) => ({
          id: `book-file-${i}`,
          name: f.file,
          parentId: 'series-folder',
          kind: 'file' as const,
          extension: '.m4b',
          size: statSync(path.join(scratchDir, f.file)).size,
        })),
      ]

      const provider = makeFakeProvider(entries, fileServers)
      const source = await insertSource()

      const result = await scanGoogleDriveSource(source, provider)

      expect(result.found).toBe(3) // three separate candidates, not one merged
      expect(result.created).toBe(3)
      expect(result.failed).toBe(0)

      const books = getDb().prepare('SELECT * FROM books WHERE source_id = ? ORDER BY title').all(source.id) as any[]
      expect(books).toHaveLength(3)
      expect(books.map((b) => b.title)).toEqual([
        "Carl's Doomsday Scenario",
        'Dungeon Crawler Carl',
        'The Dungeon Anarchists Cookbook',
      ])
      for (const book of books) {
        const chapters = getDb().prepare('SELECT * FROM chapters WHERE book_id = ?').all(book.id) as any[]
        expect(chapters).toHaveLength(1) // each its own single-chapter book, not merged
      }
    } finally {
      await Promise.all(servers.map((s) => s.close()))
    }
  }, 30_000)
})

afterAll(() => {})
