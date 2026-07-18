import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFolder,
  listChildren,
  getFileMetadata,
  buildDownloadUrl,
} from '../src/integrations/remote/googleDrive/driveClient.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createFolder', () => {
  it('POSTs a folder-mimeType create request and returns the new folder', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      expect(body).toEqual({ name: 'OzzBooks Audiobooks', mimeType: 'application/vnd.google-apps.folder' })
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
      return { ok: true, json: async () => ({ id: 'new-folder-id', name: 'OzzBooks Audiobooks', mimeType: 'application/vnd.google-apps.folder' }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const folder = await createFolder('test-token', 'OzzBooks Audiobooks')
    expect(folder.id).toBe('new-folder-id')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('includes a parent id when given one', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      expect(body.parents).toEqual(['parent-id'])
      return { ok: true, json: async () => ({ id: 'child-id', name: 'x', mimeType: 'application/vnd.google-apps.folder' }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await createFolder('test-token', 'x', 'parent-id')
  })

  it('throws with response detail on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => '{"error":"insufficient permissions"}' })),
    )
    await expect(createFolder('test-token', 'x')).rejects.toThrow('403')
  })
})

describe('listChildren', () => {
  it('returns an empty array without making a request for zero folder ids', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await listChildren('test-token', [])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('follows nextPageToken until exhausted', async () => {
    let call = 0
    const fetchMock = vi.fn(async (url: string) => {
      call++
      expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain("'folder-1' in parents")
      if (call === 1) {
        return { ok: true, json: async () => ({ files: [{ id: 'f1', name: 'a', mimeType: 'audio/mp4' }], nextPageToken: 'page-2' }) }
      }
      expect(url).toContain('pageToken=page-2')
      return { ok: true, json: async () => ({ files: [{ id: 'f2', name: 'b', mimeType: 'audio/mp4' }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const files = await listChildren('test-token', ['folder-1'])
    expect(files.map((f) => f.id)).toEqual(['f1', 'f2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('batches folder ids into multiple queries when over the per-query limit', async () => {
    const manyFolderIds = Array.from({ length: 85 }, (_, i) => `folder-${i}`)
    const queries: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        queries.push(url)
        return { ok: true, json: async () => ({ files: [] }) }
      }),
    )

    await listChildren('test-token', manyFolderIds)
    // 85 folders at 40 per batch -> 3 queries (40, 40, 5)
    expect(queries).toHaveLength(3)
  })
})

describe('getFileMetadata', () => {
  it('fetches a single file by id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/files/some-file-id')
        return { ok: true, json: async () => ({ id: 'some-file-id', name: 'book.m4b', mimeType: 'audio/mp4', size: '12345' }) }
      }),
    )
    const file = await getFileMetadata('test-token', 'some-file-id')
    expect(file.size).toBe('12345')
  })
})

describe('buildDownloadUrl', () => {
  it('builds an alt=media URL with no auth attached (caller adds that)', () => {
    expect(buildDownloadUrl('abc123')).toBe('https://www.googleapis.com/drive/v3/files/abc123?alt=media')
  })
})
