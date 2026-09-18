import { randomUUID } from 'node:crypto'
import { getDb } from '../../../db/index.js'
import { logActivity } from '../../../db/activityLog.js'
import { extractArtwork } from '../../../ingestion/artwork.js'
import { remoteContentHash } from '../../../ingestion/contentHash.js'
import {
  writeBookAndChapters,
  deriveAuthorFromSegments,
  deriveSeriesFromSegments,
  BACKUP_FOLDER_RE,
  fillIfMissing,
  type ScanResult,
} from '../../../ingestion/scan.js'
import type { BookRow, SourceRow } from '../../../types.js'
import { getValidAccessToken } from '../credentials.js'
import type { RemoteEntry, RemoteProvider } from '../types.js'
import { ingestRemoteM4b, ingestRemoteM4bParts, ingestRemoteMp3Folder } from './remoteMetadata.js'
import {
  groupM4bParts,
  groupChapterRipsByPrefix,
  groupParenthesizedTrackRips,
  extractLeadingIndexTag,
} from '../../../ingestion/partGrouping.js'

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
  /** A "(#N)" prefix stripped from the owning folder's name (see
   * extractLeadingIndexTag) — a real, if low-priority, series-number
   * signal alongside the local pipeline's folder-name-based guess. Null
   * for a single-file candidate (its name comes from the file itself, not
   * a folder, so this convention never applies) or when the folder name
   * carries no such prefix. */
  seriesIndexNumber: number | null
}

// Same container as .m4b (Apple's convention for "M4A with chapter
// markers") — treated identically here, matching scan.ts's local
// equivalent (isM4bFile).
const M4B_EXTENSIONS = new Set<string | undefined>(['.m4b', '.m4a'])

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
  // M4B files claimed by the folder-based chapter/part grouping below, so
  // the single-file loop after it doesn't also treat them as their own
  // separate book.
  //
  // REDESIGNED 2026-09-11 after a real-data incident — the original "2+
  // M4B files in a folder = one book" rule was too broad: it wrongly
  // merged several folders holding multiple different standalone books
  // (e.g. a "Jim Butcher" folder with 10 separate novels, each already
  // having its own full embedded chapter structure) into one fake book.
  // File count alone can't distinguish that from a genuine chapter-per-
  // file rip. Replaced with two independent, narrow, real-data-tested
  // filename patterns (see partGrouping.ts for the full reasoning behind
  // each): groupM4bParts (identical base + a trailing part/disc marker —
  // e.g. the Dresden Files "-1" size-split books) runs first, then
  // groupChapterRipsByPrefix (a shared long title prefix + " - N - " + an
  // actual chapter label — e.g. Going Postal's 19 per-chapter files) runs
  // on whatever's left, so a file can never be claimed by both. Every
  // real case from the incident — the correct merges and the wrong ones —
  // is a regression test in partGrouping.test.ts. See
  // ozzbooks-google-drive-chapter-merge-fix memory for the full incident
  // and the repair already applied to the affected books.
  const groupedM4bIds = new Set<string>()
  for (const folder of folderById.values()) {
    if (isUnderExcludedFolder(folder.id, folderById)) continue
    const children = filesByParent.get(folder.id) ?? []
    const m4bChildren = children.filter((c) => M4B_EXTENSIONS.has(c.extension))
    if (m4bChildren.length < 2) continue

    const byName = new Map(m4bChildren.map((c) => [c.name, c]))
    const { groups: partGroups, singles: afterPartGrouping } = groupM4bParts(m4bChildren.map((c) => c.name))
    const { groups: chapterRipGroups, singles: afterChapterRipGrouping } = groupChapterRipsByPrefix(afterPartGrouping)
    const { groups: parenthesizedTrackGroups } = groupParenthesizedTrackRips(afterChapterRipGrouping)
    const segments = buildSegmentsToFolder(folder.id, folderById)

    const { title: cleanedFolderName, index: folderIndexNumber } = extractLeadingIndexTag(folder.name)

    for (const groupNames of [...partGroups, ...chapterRipGroups, ...parenthesizedTrackGroups]) {
      const groupEntries = groupNames.map((n) => byName.get(n)!)
      for (const e of groupEntries) groupedM4bIds.add(e.id)
      candidates.push({
        format: 'm4b',
        id: `gdrive://${groupEntries[0].id}`,
        name: cleanedFolderName,
        authorSegments: segments,
        seriesSegments: segments,
        hashInput: groupEntries[0],
        files: groupEntries,
        seriesIndexNumber: folderIndexNumber,
      })
    }
  }

  for (const entry of entries) {
    if (entry.kind !== 'file' || !M4B_EXTENSIONS.has(entry.extension)) continue
    if (groupedM4bIds.has(entry.id)) continue
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
      seriesIndexNumber: null,
    })
  }

  for (const folder of folderById.values()) {
    const children = filesByParent.get(folder.id) ?? []
    const hasM4b = children.some((c) => M4B_EXTENSIONS.has(c.extension))
    const mp3s = children.filter((c) => c.extension === '.mp3')
    if (hasM4b || mp3s.length === 0) continue // matches local: mp3s alongside an m4b are never their own candidate
    if (isUnderExcludedFolder(folder.id, folderById)) continue

    const sortedMp3s = [...mp3s].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const segments = buildSegmentsToFolder(folder.id, folderById)
    const { title: cleanedFolderName, index: folderIndexNumber } = extractLeadingIndexTag(folder.name)
    candidates.push({
      format: 'mp3_folder',
      id: `gdrive-folder://${folder.id}`,
      name: cleanedFolderName,
      authorSegments: segments,
      seriesSegments: segments,
      hashInput: sortedMp3s[0],
      files: sortedMp3s,
      seriesIndexNumber: folderIndexNumber,
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

/** Marks every active book for a source missing — same "never delete"
 * treatment as a file that disappears from a local scan, reusing the
 * identical UPDATE statement scanSource() runs for that case. Shared by
 * the automatic needs_reconnect short-circuit below and the deliberate
 * Disconnect route (sources.ts), which deliberately does NOT also call
 * recordScanStats since disconnecting isn't a scan. Reconnecting reuses
 * this same source row and a normal scan un-misses matching books via
 * the same hash/path matching below. */
export function markSourceBooksMissing(sourceId: string): number {
  const db = getDb()
  const previouslyActive = db.prepare("SELECT * FROM books WHERE source_id = ? AND status = 'active'").all(sourceId) as BookRow[]
  for (const book of previouslyActive) {
    db.prepare(
      "UPDATE books SET status = 'missing', missing_since = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).run(book.id)
  }
  return previouslyActive.length
}

/** A confirmed revoked/dead grant (credentials_status already flipped by
 * credentials.ts) short-circuits to marking this source's books missing. */
function markAllMissing(source: SourceRow): ScanResult {
  const markedMissing = markSourceBooksMissing(source.id)
  const result: ScanResult = {
    found: 0,
    created: 0,
    updated: 0,
    markedMissing,
    skippedDuplicates: 0,
    failed: 0,
    removedAsTrash: 0,
    autoReplaced: 0,
    companionLinked: 0,
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
  // Same tie-breaker as the local pipeline's buildSeriesSiblingCounts: a
  // flat folder (file/group sitting directly under it, no separate book
  // folder) only reads as a series if more than one candidate shares it.
  const seriesSiblingCounts = new Map<string, number>()
  for (const candidate of candidates) {
    const key = candidate.seriesSegments.join('/')
    seriesSiblingCounts.set(key, (seriesSiblingCounts.get(key) ?? 0) + 1)
  }

  const result: ScanResult = {
    found: candidates.length,
    created: 0,
    updated: 0,
    markedMissing: 0,
    skippedDuplicates: 0,
    failed: 0,
    removedAsTrash: 0,
    autoReplaced: 0,
    companionLinked: 0,
  }
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
          ? candidate.files.length > 1
            ? await ingestRemoteM4bParts(
                await Promise.all(
                  candidate.files.map(async (file) => {
                    const access = await provider.getMetadataAccess(source, credentials, file.id)
                    return { url: access.url, headers: access.headers, fileName: file.name, fileUri: `gdrive://${file.id}` }
                  }),
                ),
                candidate.name,
              )
            : await ingestRemoteM4b(primaryAccess.url, primaryAccess.headers, candidate.hashInput.name, candidate.id)
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
      const siblingBookCount = seriesSiblingCounts.get(candidate.seriesSegments.join('/')) ?? 1
      const seriesName = deriveSeriesFromSegments(candidate.seriesSegments, siblingBookCount)
      const bookId = existing?.id ?? randomUUID()
      const artwork = await extractArtwork(bookId, NO_LOCAL_FOLDER, ingested.artworkMetadata)

      // A grouped candidate's title (see discoverCandidates) is already
      // stripped of any "(#N)" folder prefix — extracting again here is a
      // harmless no-op for it. This is what actually catches the case that
      // matters: a *single*-file M4B whose own filename/embedded tag still
      // carries the prefix (e.g. "(#9) Eric.m4b" with no title tag, sitting
      // in its own "(#9) Eric" folder) — discoverCandidates never touches a
      // single file's name, so without this the prefix would otherwise
      // reach ingested.title untouched.
      const { title: cleanedTitle, index: titleIndexNumber } = extractLeadingIndexTag(ingested.title)
      const folderIndexNumber = candidate.seriesIndexNumber ?? titleIndexNumber

      // Same manual > folder > tag precedence as the local pipeline's
      // resolveSeriesNumber: once a user has manually corrected it, that
      // value must survive every future rescan; otherwise a folder-derived
      // "(#N)" guess (see extractLeadingIndexTag) beats a bare embedded tag
      // the same way a local "Series Name 16 - Title" folder already would.
      const seriesNumber = existing?.series_number_source === 'manual'
        ? existing.series_number
        : folderIndexNumber ?? ingested.seriesNumber
      const seriesNumberSource =
        existing?.series_number_source === 'manual'
          ? 'manual'
          : folderIndexNumber !== null
            ? 'folder'
            : ingested.seriesNumber !== null
              ? 'tag'
              : null

      const wasHashRelink = Boolean(existing && existing.file_path !== candidate.id)
      const previousPath = existing?.file_path

      const { created } = writeBookAndChapters(source, bookId, !existing, {
        filePath: candidate.id,
        format: candidate.format,
        title: cleanedTitle,
        author,
        seriesName,
        seriesNumber,
        seriesNumberSource,
        artworkThumbPath: artwork?.thumbPath ?? null,
        artworkFullPath: artwork?.fullPath ?? null,
        contentHash: hash,
        chapters: ingested.chapters,
      })
      fillIfMissing(bookId, 'narrator', ingested.narrator)

      if (created) {
        result.created++
        logActivity(bookId, cleanedTitle, author, 'created')
      } else {
        result.updated++
        if (wasHashRelink) {
          logActivity(bookId, cleanedTitle, author, 'relinked', `Same content found at a new path — moved from ${previousPath}`)
        }
      }
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
      db.prepare(
        "UPDATE books SET status = 'missing', missing_since = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      ).run(book.id)
      result.markedMissing++
      logActivity(book.id, book.title, book.author, 'missing', `File no longer found in Drive`)
    }
  }

  recordScanStats(source, result)
  return result
}
