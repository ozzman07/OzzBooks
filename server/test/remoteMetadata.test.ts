import { createServer, type Server } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestLibrary, type TestLibrary } from './fixtures.js'
import { ingestRemoteM4b, ingestRemoteMp3Folder } from '../src/integrations/remote/googleDrive/remoteMetadata.js'

// Serves a single local file with Range support — a stand-in for Drive's
// alt=media endpoint, so ffprobe-over-URL and the range-tokenizer path
// get exercised against a real HTTP server and real audio bytes, not
// mocked responses. This is the single riskiest, most novel piece of the
// whole remote-source design (confirming ffprobe's -headers flag and
// @tokenizer/range's fetch-based client both actually work over real
// HTTP Range requests) — worth real coverage, not a live-credentials-only
// leap of faith.
function serveFileWithRanges(filePath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const { size } = statSync(filePath)
  const server: Server = createServer((req, res) => {
    // Require the Authorization header on every request, matching Drive's
    // real endpoint — proves headers actually reach the server, not just
    // that a request without them happens to work.
    if (req.headers.authorization !== 'Bearer test-token') {
      res.writeHead(401).end()
      return
    }

    const range = req.headers.range
    if (range) {
      const match = /bytes=(\d+)-(\d+)?/.exec(range)
      const start = Number(match![1])
      const end = match![2] ? Number(match![2]) : size - 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      })
      createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
      if (req.method === 'HEAD') {
        res.end()
      } else {
        createReadStream(filePath).pipe(res)
      }
    }
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/fake-file`,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}

let library: TestLibrary

beforeAll(async () => {
  library = await buildTestLibrary()
}, 30_000)

describe('ingestRemoteM4b (real ffprobe-over-URL + tokenizer-over-URL against a real HTTP server)', () => {
  it('extracts chapters, title, and author from a real M4B served over HTTP with auth headers', async () => {
    const { url, close } = await serveFileWithRanges(library.m4bPath)
    try {
      const result = await ingestRemoteM4b(url, { Authorization: 'Bearer test-token' }, 'Mistborn.m4b', 'gdrive://fake-id')

      expect(result.title).toBe('Mistborn: The Final Empire')
      expect(result.author).toBe('Brandon Sanderson')
      expect(result.chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter One'])
      expect(result.chapters[0].startTime).toBeCloseTo(0, 1)
      expect(result.chapters[1].startTime).toBeCloseTo(2, 1)
      // Every chapter shares the same remote file URI — same shared-file,
      // time-offset model as local M4B chapters.
      expect(result.chapters[0].filePath).toBe('gdrive://fake-id')
      expect(result.chapters[1].filePath).toBe('gdrive://fake-id')
    } finally {
      await close()
    }
  }, 30_000)

  it('rejects requests without the expected auth header (proves headers actually reach the server)', async () => {
    const { url, close } = await serveFileWithRanges(library.m4bPath)
    try {
      await expect(ingestRemoteM4b(url, { Authorization: 'Bearer wrong-token' }, 'x.m4b', 'gdrive://x')).rejects.toThrow()
    } finally {
      await close()
    }
  }, 30_000)
})

describe('ingestRemoteMp3Folder (real range-tokenizer parse of real MP3 files)', () => {
  it('extracts and sorts chapters from real MP3 files served over HTTP', async () => {
    const files = [
      { name: '01 - Chapter One.mp3', path: `${library.mp3FolderDir}/01 - Chapter One.mp3` },
      { name: '02 - Chapter Two.mp3', path: `${library.mp3FolderDir}/02 - Chapter Two.mp3` },
      { name: '03 - Chapter Three.mp3', path: `${library.mp3FolderDir}/03 - Chapter Three.mp3` },
    ]
    const servers = await Promise.all(files.map((f) => serveFileWithRanges(f.path)))

    try {
      const result = await ingestRemoteMp3Folder(
        'Project Hail Mary',
        files.map((f, i) => ({
          fileId: `file-${i}`,
          fileName: f.name,
          url: servers[i].url,
          headers: { Authorization: 'Bearer test-token' },
        })),
      )

      expect(result.title).toBe('Project Hail Mary')
      expect(result.author).toBe('Andy Weir')
      expect(result.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two', 'Chapter Three'])
      expect(result.chapters.every((c) => c.duration > 0)).toBe(true)
      expect(result.chapters.every((c) => c.startTime === 0)).toBe(true)
    } finally {
      await Promise.all(servers.map((s) => s.close()))
    }
  }, 30_000)
})

afterAll(() => {
  // buildTestLibrary() creates real temp directories — no explicit
  // cleanup elsewhere in the suite either, matching existing convention.
})
