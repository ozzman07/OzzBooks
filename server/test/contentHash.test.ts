import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentHash, remoteContentHash } from '../src/ingestion/contentHash.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('contentHash / remoteContentHash comparability', () => {
  it('produces the identical hash for the same bytes, local vs remote', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-hash-'))
    // Bigger than the 64KB sample window on both ends, so head and tail
    // samples are genuinely distinct — a more faithful test than a tiny file.
    const fileBytes = randomBytes(200 * 1024)
    const filePath = path.join(dir, 'book.m4b')
    await writeFile(filePath, fileBytes)

    const localHash = await contentHash(filePath)

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const range = (init!.headers as Record<string, string>).Range
        const match = /bytes=(\d+)-(\d+)/.exec(range)!
        const start = Number(match[1])
        const end = Number(match[2])
        return { ok: true, status: 206, arrayBuffer: async () => fileBytes.subarray(start, end + 1) }
      }),
    )

    const remoteHash = await remoteContentHash('https://example.com/fake-file', {}, fileBytes.length)
    expect(remoteHash).toBe(localHash)
  })

  it('produces a different hash for different content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 206, arrayBuffer: async () => new Uint8Array(1000) })),
    )
    const a = await remoteContentHash('https://example.com/a', {}, 1000)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 206, arrayBuffer: async () => new Uint8Array(1000).fill(1) })),
    )
    const b = await remoteContentHash('https://example.com/b', {}, 1000)

    expect(a).not.toBe(b)
  })

  it('throws a clear error on a failed range request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })))
    await expect(remoteContentHash('https://example.com/x', {}, 1000)).rejects.toThrow('Range request failed')
  })
})
