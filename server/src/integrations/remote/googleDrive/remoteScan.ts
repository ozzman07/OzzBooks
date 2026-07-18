import { randomUUID } from 'node:crypto'
import { getDb } from '../../../db/index.js'
import { extractArtwork } from '../../../ingestion/artwork.js'
import { remoteContentHash } from '../../../ingestion/contentHash.js'
import {
  writeBookAndChapters,
  deriveAuthorFromSegments,
  deriveSeriesFromSegments,
  BACKUP_FOLDER_RE,
  type ScanResult,
} from '../../../ingestion/scan.js'
import type { BookRow, SourceRow } from '../../../types.js'
import { getValidAccessToken } from '../credentials.js'
import type { RemoteEntry, RemoteProvider } from '../types.js'
import { ingestRemoteM4b, ingestRemoteMp3Folder } from './remoteMetadata.js'

// extractArtwork() falls back to checking for a local cover.jpg/folder.jpg
// only when there's no embedded picture — passing a path that can never
// exist makes that fallback a safe, deliberate no-op for remote books
// (which have no local folder to check), rather than reusing embedded
// art only. Known v1 scope limitation: a Drive folder's own cover.jpg
// sitting alongside the audio isn't picked up, only embedded art is.
const NO_LOCAL_FOLDER = '/nonexistent-remote-source-has-no-local-folder'

function buildSegmentsToFolder(folderId: string | null, folderById: Map<string, RemoteEntry>): string[] {
  const segments: string[] = []
  let current = folderId
  while (current) {
    const folder = folderById.get(current)
    if (!folder) break
    segments.unshift(folder.name)
    current = folder.parentId
  }
  return segments
}

function isUnderExcludedFolder(folderId: string | null, folderById: Map<string, RemoteEntry>): boolean {
  let current = folderId
  while (current) {
    const folder = folderById.get(current)
    if (!folder) break
    if (BACKUP_FOLDER_RE.test(folder.name)) return true
    current = folder.parentId
  }
  return false
}

interface DriveCandidate {
  format: 'm4b' | 'mp3_folder'
  /** books.file_path equivalent — gdrive://<fileId> for m4b, a synthetic
   * gdrive-folder://<folderId> for mp3_folder (no single file to point
   * at, mirrors how local mp3_folder's file_path is the folder itself). */
  id: string
  name: string
  authorSegments: string[]
  seriesSegments: string[]
  /** The file used for hashing/primary-metadata parsing — the m4b itself,
   * or the first (sorted) mp3 in a folder. */
  hashInput: RemoteEntry
  files: RemoteEntry[]
}

function discoverCandidates(entries: RemoteEntry[]): DriveCandidate[] {
  const folderById = new Map(entries.filter((e) => e.kind === 'folder').map((e) => [e.id, e]))
  const filesByParent = new Map<string, RemoteEntry[]>()
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const key = entry.parentId ?? ''
    const list = filesByParent.get(key) ?? []
    list.push(entry)
    filesByParent.set(key, list)
  }

  const candidates: DriveCandidate[] = []

  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.extension !== '.m4b') continue
    if (isUnderExcludedFolder(entry.parentId, folderById)) continue
    const seriesSegments = buildSegmentsToFolder(entry.parentId, folderById)
    candidates.push({
      format: 'm4b',
      id: `gdrive://${entry.id}`,
      name: entry.name,
      authorSegments: [...seriesSegments, entry.name],
      seriesSegments,
      hashInput: entry,
      files: [entry],
    })
  }

  for (const folder of folderById.values()) {
    const children = filesByParent.get(folder.id) ?? []
    const hasM4b = children.some((c) => c.extension === '.m4b')
    const mp3s = children.filter((c) => c.extension === '.mp3')
    if (hasM4b || mp3s.length === 0) continue // matches local: mp3s alongside an m4b are never their own candidate
    if (isUnderExcludedFolder(folder.id, folderById)) continue

    const sortedMp3s = [...mp3s].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const segments = buildSegmentsToFolder(folder.id, folderById)
    candidates.push({
      format: 'mp3_folder',
      id: `gdrive-folder://${folder.id}`,
      name: folder.name,
      authorSegments: segments,
      seriesSegments: segments,
      hashInput: sortedMp3s[0],
      files: sortedMp3s,
    })
  }

  return candidates
}

function recordScanStats(source: SourceRow, result: ScanResult): void {
  getDb()
    .prepare(
      `UPDATE sources SET
         last_scanned_at = datetime('now'),
         last_scan_found = ?, last_scan_created = ?, last_scan_updated = ?,
         last_scan_failed = ?, last_scan_skipped_duplicates = ?
       WHERE id = ?`,
    )
    .run(result.found, result.created, result.updated, result.failed, result.skippedDuplicates, source.id)
}

/** A confirmed revoked/dead grant (credentials_status already flipped by
 * credentials.ts) short-circuits to marking this source's books missing
 * — same "never delete" treatment as a file that disappears from a local
 * scan, reusing the identical UPDATE statement scanSource() runs for
 * that case. Reconnecting reuses this same source row and a normal scan
 * un-misses matching books via the same hash/path matching below. */
function markAllMissing(source: SourceRow): ScanResult {
  const db = getDb()
  const previouslyActive = db.prepare("SELECT * FROM books WHERE source_id = ? AND status = 'active'").all(source.id) as BookRow[]
  for (const book of previouslyActive) {
    db.prepare("UPDATE books SET status = 'missing', updated_at = datetime('now') WHERE id = ?").run(book.id)
  }
  const result: ScanResult = {
    found: 0,
    created: 0,
    updated: 0,
    markedMissing: previouslyActive.length,
    skippedDuplicates: 0,
    failed: 0,
  }
  recordScanStats(source, result)
  return result
}

export async function scanGoogleDriveSource(source: SourceRow, provider: RemoteProvider): Promise<ScanResult> {
  const db = getDb()

  if (source.credentials_status === 'needs_reconnect') {
    return markAllMissing(source)
  }

  const credentials = await getValidAccessToken(source, provider)
  const entries = await provider.listTree(source, credentials)
  const candidates = discoverCandidates(entries)

  const result: ScanResult = { found: candidates.length, created: 0, updated: 0, markedMissing: 0, skippedDuplicates: 0, failed: 0 }
  const seenFilePaths = new Set<string>()

  db.prepare('DELETE FROM scan_issues WHERE source_id = ?').run(source.id)

  for (const candidate of candidates) {
    seenFilePaths.add(candidate.id)

    try {
      const primaryAccess = await provider.getMetadataAccess(source, credentials, candidate.hashInput.id)
      const size = candidate.hashInput.size ?? 0
      const hash = await remoteContentHash(primaryAccess.url, primaryAccess.headers, size)

      let existing = db
        .prepare<[string, string], BookRow>('SELECT * FROM books WHERE source_id = ? AND file_path = ?')
        .get(source.id, candidate.id)

      if (!existing) {
        const duplicate = db
          .prepare<[string, string], BookRow>('SELECT * FROM books WHERE content_hash = ? AND source_id != ?')
          .get(hash, source.id)
        if (duplicate) {
          result.skippedDuplicates++
          continue
        }

        // Same-source hash match: this file moved within Drive (renamed/
        // reorganized folder) rather than being genuinely new — mirrors
        // scan.ts's local same-source relink-by-hash logic exactly.
        const relinkMatch = db
          .prepare<[string, string, string], BookRow>(
            'SELECT * FROM books WHERE source_id = ? AND content_hash = ? AND file_path != ?',
          )
          .get(source.id, hash, candidate.id)
        if (relinkMatch && !seenFilePaths.has(relinkMatch.file_path)) {
          existing = relinkMatch
        }
      }

      const ingested =
        candidate.format === 'm4b'
          ? await ingestRemoteM4b(primaryAccess.url, primaryAccess.headers, candidate.hashInput.name, candidate.id)
          : await ingestRemoteMp3Folder(
              candidate.name,
              await Promise.all(
                candidate.files.map(async (file) => {
                  const access = await provider.getMetadataAccess(source, credentials, file.id)
                  return { fileId: file.id, fileName: file.name, url: access.url, headers: access.headers }
                }),
              ),
            )

      const author = deriveAuthorFromSegments(candidate.authorSegments) ?? ingested.author
      const seriesName = deriveSeriesFromSegments(candidate.seriesSegments)
      const bookId = existing?.id ?? randomUUID()
      const artwork = await extractArtwork(bookId, NO_LOCAL_FOLDER, ingested.artworkMetadata)

      const { created } = writeBookAndChapters(source, bookId, !existing, {
        filePath: candidate.id,
        format: candidate.format,
        title: ingested.title,
        author,
        seriesName,
        seriesNumber: ingested.seriesNumber,
        artworkThumbPath: artwork?.thumbPath ?? null,
        artworkFullPath: artwork?.fullPath ?? null,
        contentHash: hash,
        chapters: ingested.chapters,
      })

      if (created) result.created++
      else result.updated++
    } catch (err) {
      // A single inaccessible/corrupt remote file shouldn't abort the
      // whole scan — same treatment as a corrupt local file.
      console.warn(`Skipping unreadable remote file during scan: ${candidate.name}`, err)
      result.failed++
      db.prepare('INSERT INTO scan_issues (id, source_id, file_path, error) VALUES (?, ?, ?, ?)').run(
        randomUUID(),
        source.id,
        candidate.name,
        String(err),
      )
    }
  }

  const previouslyActive = db
    .prepare<[string], BookRow>("SELECT * FROM books WHERE source_id = ? AND status = 'active'")
    .all(source.id)
  for (const book of previouslyActive) {
    if (!seenFilePaths.has(book.file_path)) {
      db.prepare("UPDATE books SET status = 'missing', updated_at = datetime('now') WHERE id = ?").run(book.id)
      result.markedMissing++
    }
  }

  recordScanStats(source, result)
  return result
}
