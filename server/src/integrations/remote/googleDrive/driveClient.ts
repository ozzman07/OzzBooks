const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const FIELDS = 'id,name,parents,mimeType,size,modifiedTime'
// Stay well under Drive's query-length limits while still cutting
// round-trips by a large factor vs one request per folder — an unbatched
// walk over a large library is a real risk, not a later perf concern
// (relink.ts's own finding: an unscoped *local* walk over ~2,400 books
// takes several minutes; an unbatched remote walk would be worse).
const MAX_PARENTS_PER_QUERY = 40

export interface DriveFile {
  id: string
  name: string
  parents?: string[]
  mimeType: string
  size?: string // Drive returns this as a string
  modifiedTime?: string
}

async function driveFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DRIVE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Drive API request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`)
  }
  return res.json() as Promise<T>
}

/** Creates a folder — the app-owned root a connected source's files live
 * under (drive.file scope only grants access to what the app itself
 * creates, or what the user explicitly opens via Picker — this project
 * doesn't use Picker, see the plan). */
export async function createFolder(accessToken: string, name: string, parentId?: string): Promise<DriveFile> {
  return driveFetch<DriveFile>(accessToken, '/files?fields=id,name,mimeType', {
    method: 'POST',
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  })
}

/** Lists every direct child (file or folder) of the given folder ids,
 * batching multiple folders into one query (OR'd `'id' in parents`
 * clauses) and paginating within each batch. Folder ids are always
 * Drive-generated safe strings, never user-controlled text, so no query
 * escaping is needed for them. */
export async function listChildren(accessToken: string, folderIds: string[]): Promise<DriveFile[]> {
  if (folderIds.length === 0) return []
  const results: DriveFile[] = []

  for (let i = 0; i < folderIds.length; i += MAX_PARENTS_PER_QUERY) {
    const batch = folderIds.slice(i, i + MAX_PARENTS_PER_QUERY)
    const parentClauses = batch.map((id) => `'${id}' in parents`).join(' or ')
    const q = `(${parentClauses}) and trashed = false`

    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken, files(${FIELDS})`,
        pageSize: '1000',
        ...(pageToken ? { pageToken } : {}),
      })
      const page = await driveFetch<{ files: DriveFile[]; nextPageToken?: string }>(
        accessToken,
        `/files?${params.toString()}`,
      )
      results.push(...page.files)
      pageToken = page.nextPageToken
    } while (pageToken)
  }

  return results
}

export async function getFileMetadata(accessToken: string, fileId: string): Promise<DriveFile> {
  return driveFetch<DriveFile>(accessToken, `/files/${fileId}?fields=${FIELDS}`)
}

/** Not fetched here — the caller (streaming proxy / metadata extraction)
 * attaches the Authorization header itself, since this URL alone is
 * meaningless without it. */
export function buildDownloadUrl(fileId: string): string {
  return `${DRIVE_API_BASE}/files/${fileId}?alt=media`
}
