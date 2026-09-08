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

/** Creates a folder — the app-owned default root a freshly-connected
 * source's files live under, offered as the zero-friction option
 * alongside Picker's "choose an existing folder instead" (see
 * sources.ts's POST /:id/folder). Works regardless of OAuth scope since
 * the app itself owns whatever it creates. */
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

// Google's Drive API 404s ("File not found") on a file/folder id that has
// ever been shared via a link unless this header accompanies the
// request — even for the owner in some cases. Picker returns a
// resourceKey for exactly this reason on its selection callback; a
// picked folder's id alone isn't always enough. Format is a
// comma-separated list of "fileId/resourceKey" pairs — only ids that
// actually have one need an entry, everything else is looked up
// normally. See sources.ts's POST /:id/folder for where this gets
// captured and stored.
function resourceKeyHeader(ids: string[], resourceKeys?: Record<string, string>): Record<string, string> | undefined {
  if (!resourceKeys) return undefined
  const pairs = ids.filter((id) => resourceKeys[id]).map((id) => `${id}/${resourceKeys[id]}`)
  return pairs.length > 0 ? { 'X-Goog-Drive-Resource-Keys': pairs.join(',') } : undefined
}

/** Lists every direct child (file or folder) of the given folder ids,
 * batching multiple folders into one query (OR'd `'id' in parents`
 * clauses) and paginating within each batch. Folder ids are always
 * Drive-generated safe strings, never user-controlled text, so no query
 * escaping is needed for them. */
export async function listChildren(
  accessToken: string,
  folderIds: string[],
  resourceKeys?: Record<string, string>,
): Promise<DriveFile[]> {
  if (folderIds.length === 0) return []
  const results: DriveFile[] = []

  for (let i = 0; i < folderIds.length; i += MAX_PARENTS_PER_QUERY) {
    const batch = folderIds.slice(i, i + MAX_PARENTS_PER_QUERY)
    const parentClauses = batch.map((id) => `'${id}' in parents`).join(' or ')
    const q = `(${parentClauses}) and trashed = false`
    const headers = resourceKeyHeader(batch, resourceKeys)

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
        headers ? { headers } : undefined,
      )
      results.push(...page.files)
      pageToken = page.nextPageToken
    } while (pageToken)
  }

  return results
}

export async function getFileMetadata(accessToken: string, fileId: string, resourceKey?: string | null): Promise<DriveFile> {
  const headers = resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${fileId}/${resourceKey}` } : undefined
  return driveFetch<DriveFile>(accessToken, `/files/${fileId}?fields=${FIELDS}`, headers ? { headers } : undefined)
}

/** Not fetched here — the caller (streaming proxy / metadata extraction)
 * attaches the Authorization header itself, since this URL alone is
 * meaningless without it. */
export function buildDownloadUrl(fileId: string): string {
  return `${DRIVE_API_BASE}/files/${fileId}?alt=media`
}
