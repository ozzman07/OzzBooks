import { afterEach, describe, expect, it, vi } from 'vitest'
import { googleDriveProvider } from '../src/integrations/remote/googleDrive/provider.js'
import type { SourceRow } from '../src/types.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const fakeSource = { id: 's1', path_scope: 'root-folder-id' } as SourceRow
const credentials = { accessToken: 'token-abc', refreshToken: 'refresh-abc' }

describe('googleDriveProvider', () => {
  it('has type "google_drive"', () => {
    expect(googleDriveProvider.type).toBe('google_drive')
  })

  it('ensureManagedFolder creates a folder named "OzzBooks Audiobooks"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string)
        expect(body.name).toBe('OzzBooks Audiobooks')
        return { ok: true, json: async () => ({ id: 'folder-1', name: 'OzzBooks Audiobooks', mimeType: 'application/vnd.google-apps.folder' }) }
      }),
    )
    const result = await googleDriveProvider.ensureManagedFolder(credentials)
    expect(result).toEqual({ folderId: 'folder-1', label: 'OzzBooks Audiobooks' })
  })

  it('getMetadataAccess returns the download URL with auth headers', async () => {
    const access = await googleDriveProvider.getMetadataAccess(fakeSource, credentials, 'file-1')
    expect(access.url).toBe('https://www.googleapis.com/drive/v3/files/file-1?alt=media')
    expect(access.headers).toEqual({ Authorization: 'Bearer token-abc' })
  })

  it('listTree walks the folder tree level by level and classifies files vs folders', async () => {
    const responsesByFolder: Record<string, unknown> = {
      'root-folder-id': {
        files: [
          { id: 'sub-folder', name: 'Author Name', mimeType: 'application/vnd.google-apps.folder', parents: ['root-folder-id'] },
          { id: 'loose-file', name: 'standalone.m4b', mimeType: 'audio/mp4', parents: ['root-folder-id'], size: '1000' },
        ],
      },
      'sub-folder': {
        files: [
          { id: 'book-file', name: 'book.m4b', mimeType: 'audio/mp4', parents: ['sub-folder'], size: '5000', modifiedTime: '2026-01-01T00:00:00Z' },
        ],
      },
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const decoded = decodeURIComponent(url.replace(/\+/g, ' '))
        const folderId = Object.keys(responsesByFolder).find((id) => decoded.includes(`'${id}' in parents`))
        return { ok: true, json: async () => responsesByFolder[folderId!] ?? { files: [] } }
      }),
    )

    const entries = await googleDriveProvider.listTree(fakeSource, credentials)

    expect(entries).toHaveLength(3)
    const folder = entries.find((e) => e.id === 'sub-folder')!
    expect(folder.kind).toBe('folder')
    expect(folder.parentId).toBe('root-folder-id')

    const looseFile = entries.find((e) => e.id === 'loose-file')!
    expect(looseFile.kind).toBe('file')
    expect(looseFile.extension).toBe('.m4b')
    expect(looseFile.size).toBe(1000)

    const bookFile = entries.find((e) => e.id === 'book-file')!
    expect(bookFile.kind).toBe('file')
    expect(bookFile.parentId).toBe('sub-folder')
    expect(bookFile.modifiedTime).toBe('2026-01-01T00:00:00Z')
  })
})
