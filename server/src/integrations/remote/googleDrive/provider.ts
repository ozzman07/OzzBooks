import { extname } from 'node:path'
import type { SourceRow } from '../../../types.js'
import type { DecryptedCredentials, RemoteEntry, RemoteProvider } from '../types.js'
import { refreshAccessToken, revokeToken } from './auth.js'
import { createFolder, listChildren, buildDownloadUrl } from './driveClient.js'

const MANAGED_FOLDER_NAME = 'OzzBooks Audiobooks'
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

/**
 * Walks the tree level by level rather than depth-first — each level's
 * folder ids get passed to listChildren together, which internally
 * batches them into as few Drive queries as possible (see driveClient.ts)
 * instead of issuing one request per folder.
 */
async function listTree(source: SourceRow, credentials: DecryptedCredentials): Promise<RemoteEntry[]> {
  const results: RemoteEntry[] = []
  let currentLevelFolderIds = [source.path_scope]

  while (currentLevelFolderIds.length > 0) {
    const children = await listChildren(credentials.accessToken, currentLevelFolderIds)
    const nextLevelFolderIds: string[] = []

    for (const child of children) {
      const isFolder = child.mimeType === FOLDER_MIME_TYPE
      results.push({
        id: child.id,
        name: child.name,
        parentId: child.parents?.[0] ?? null,
        kind: isFolder ? 'folder' : 'file',
        extension: isFolder ? undefined : extname(child.name).toLowerCase(),
        size: child.size ? Number(child.size) : undefined,
        modifiedTime: child.modifiedTime,
      })
      if (isFolder) nextLevelFolderIds.push(child.id)
    }

    currentLevelFolderIds = nextLevelFolderIds
  }

  return results
}

export const googleDriveProvider: RemoteProvider = {
  type: 'google_drive',

  refreshToken: refreshAccessToken,

  async ensureManagedFolder(credentials) {
    const folder = await createFolder(credentials.accessToken, MANAGED_FOLDER_NAME)
    return { folderId: folder.id, label: folder.name }
  },

  listTree,

  async getMetadataAccess(_source, credentials, fileId) {
    return {
      url: buildDownloadUrl(fileId),
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    }
  },

  async revokeCredentials(credentials) {
    await revokeToken(credentials.accessToken)
  },
}
