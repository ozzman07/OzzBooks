import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { getDb } from '../db/index.js'
import type { BookRow, SourceRow } from '../types.js'
import { findCandidates, ingestCandidate, applyIngestedCandidate, isM4bFile, type Candidate } from './scan.js'
import { contentHash } from './contentHash.js'
import { isDrmFile } from './m4b.js'

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2) // skip short/noise words so common tokens don't dominate the score
}

/**
 * Resolves a client-supplied path (relative to the source's path_scope) to
 * an absolute filesystem path, rejecting anything that would escape
 * path_scope (e.g. "../../etc"). Every entry point below that takes a
 * client-supplied relative path goes through this first.
 */
function resolveWithinScope(source: SourceRow, relativePath: string): string {
  const scopeRoot = path.resolve(source.path_scope)
  const resolved = path.resolve(scopeRoot, relativePath)
  if (resolved !== scopeRoot && !resolved.startsWith(scopeRoot + path.sep)) {
    throw new Error('path escapes source scope')
  }
  return resolved
}

export interface RelinkCandidate {
  path: string // relative to source.path_scope
  format: 'm4b' | 'mp3_folder'
}

/**
 * Ranked suggestions for relinking a missing book: walks the source the
 * same way a normal scan does (no new traversal logic), excludes files
 * already claimed by another active book, and scores what's left by
 * word-overlap against the missing book's title/author.
 *
 * Scoped to the missing book's own author folder when it still exists,
 * rather than the whole source — measured against the real library (~2,400
 * books over an SMB-mounted NAS), an unscoped walk took several minutes,
 * which is a broken UX for something meant to load automatically when the
 * user opens the relink page (a full rescan has the same per-file cost, but
 * that's a deliberate, occasional action the user already expects to wait
 * on). The book's stored file_path still tells us what author folder it
 * used to live under even though the file itself is gone, and a reorganize
 * overwhelmingly moves a book within its own author folder, not across
 * authors. If that folder is gone too (rare), falls back to the whole
 * source rather than silently returning nothing — "Browse instead" in the
 * UI is the intended fallback for a genuinely fruitless scoped search, not
 * a slow automatic full-library retry.
 */
export async function findRelinkCandidates(source: SourceRow, book: BookRow): Promise<RelinkCandidate[]> {
  const db = getDb()
  const claimed = new Set(
    db
      .prepare<[string, string], { file_path: string }>(
        "SELECT file_path FROM books WHERE source_id = ? AND status = 'active' AND id != ?",
      )
      .all(source.id, book.id)
      .map((r) => r.file_path),
  )

  const authorFolder = path.relative(source.path_scope, book.file_path).split(path.sep)[0]
  let searchRoot = source.path_scope
  if (authorFolder) {
    const scopedDir = path.join(source.path_scope, authorFolder)
    try {
      if ((await stat(scopedDir)).isDirectory()) searchRoot = scopedDir
    } catch {
      // author folder is gone too — fall back to the whole source below
    }
  }

  const all = await findCandidates(searchRoot)
  const unclaimed = all.filter((c) => !claimed.has(c.filePath))

  const targetWords = new Set([...normalizeWords(book.title), ...normalizeWords(book.author ?? '')])

  const scored = unclaimed.map((c) => {
    const relative = path.relative(source.path_scope, c.filePath)
    const candidateWords = new Set(normalizeWords(relative))
    let score = 0
    for (const w of targetWords) if (candidateWords.has(w)) score++
    return { path: relative, format: c.format, score }
  })

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ path: p, format }) => ({ path: p, format }))
}

export interface BrowseEntry {
  name: string
  path: string // relative to source.path_scope
  type: 'folder' | 'file'
  /** true if this entry is directly usable as a relink target (an .m4b file, or a folder containing .mp3s) */
  selectable: boolean
  format?: 'm4b' | 'mp3_folder'
}

/**
 * One-level directory listing under a source, for manually browsing to a
 * relink target when the ranked suggestions don't have the right file.
 * Deliberately not `findCandidates` — this is raw navigation (show what's
 * in this folder), not book-candidate discovery, and doesn't need
 * multi-part M4B grouping or DRM warnings beyond filtering DRM files out
 * of the listing entirely.
 *
 * The per-folder "does it have mp3s" check runs in parallel (Promise.all),
 * not sequentially — confirmed against the real library this was built
 * for: browsing the source root (234 author folders) took ~3s for the
 * initial listing plus a further ~28s doing that check one folder at a
 * time over the NAS's network filesystem, all with no loading indicator
 * on the client — indistinguishable from "Browse instead" doing nothing
 * at all. Parallelized, the same check takes well under a second.
 */
export async function browseSourceDirectory(source: SourceRow, relativePath: string): Promise<BrowseEntry[]> {
  const targetDir = resolveWithinScope(source, relativePath)
  const entries = await readdir(targetDir, { withFileTypes: true })

  const results = await Promise.all(
    entries.map(async (entry): Promise<BrowseEntry | null> => {
      const entryRelative = path.join(relativePath, entry.name)
      if (entry.isDirectory()) {
        const childEntries = await readdir(path.join(targetDir, entry.name), { withFileTypes: true })
        const hasMp3 = childEntries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.mp3'))
        return {
          name: entry.name,
          path: entryRelative,
          type: 'folder',
          selectable: hasMp3,
          format: hasMp3 ? 'mp3_folder' : undefined,
        }
      }
      if (entry.isFile() && !isDrmFile(entry.name) && isM4bFile(entry.name)) {
        return { name: entry.name, path: entryRelative, type: 'file', selectable: true, format: 'm4b' }
      }
      return null
    }),
  )

  return results.filter((r): r is BrowseEntry => r !== null).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Known v1 limitation: unlike findRelinkCandidates (which goes through
 * findCandidates and gets multi-part M4B grouping for free), a manually
 * browsed pick is always treated as single-part — groupM4bParts only runs
 * during findCandidates's directory walk. Rare edge case; ranked
 * suggestions cover the common case correctly.
 */
async function buildCandidate(
  source: SourceRow,
  relativePath: string,
  format: 'm4b' | 'mp3_folder',
): Promise<Candidate> {
  const absolutePath = resolveWithinScope(source, relativePath)
  if (format === 'm4b') {
    return { format: 'm4b', filePath: absolutePath, hashInput: absolutePath, parts: [absolutePath] }
  }
  const entries = await readdir(absolutePath, { withFileTypes: true })
  const mp3 = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.mp3'))
  if (!mp3) throw new Error('no mp3 files found in folder')
  return { format: 'mp3_folder', filePath: absolutePath, hashInput: path.join(absolutePath, mp3.name) }
}

export interface RelinkPreview {
  newTitle: string
  newDurationSeconds: number
  newChapterCount: number
  oldDurationSeconds: number
  oldChapterCount: number
  /** Chapter count differs, or duration differs by more than ~10% — surfaced
   * prominently by the client before it lets the user confirm, per the
   * "catch mismatches before committing" requirement (e.g. relinking to
   * the wrong book in a series). */
  mismatchWarning: boolean
}

/** Parses the candidate file/folder without writing to the DB, so the
 * caller can show an old-vs-new sanity check before committing. */
export async function previewRelinkTarget(
  source: SourceRow,
  book: BookRow,
  relativePath: string,
  format: 'm4b' | 'mp3_folder',
): Promise<RelinkPreview> {
  const db = getDb()
  const oldChapters = db
    .prepare<[string], { duration: number }>('SELECT duration FROM chapters WHERE book_id = ?')
    .all(book.id)
  const oldDurationSeconds = oldChapters.reduce((sum, c) => sum + c.duration, 0)
  const oldChapterCount = oldChapters.length

  const candidate = await buildCandidate(source, relativePath, format)
  const ingested = await ingestCandidate(candidate)
  const newDurationSeconds = ingested.chapters.reduce((sum, c) => sum + c.duration, 0)
  const newChapterCount = ingested.chapters.length

  const durationDelta =
    oldDurationSeconds > 0 ? Math.abs(newDurationSeconds - oldDurationSeconds) / oldDurationSeconds : 0
  const mismatchWarning = newChapterCount !== oldChapterCount || durationDelta > 0.1

  return {
    newTitle: ingested.title,
    newDurationSeconds,
    newChapterCount,
    oldDurationSeconds,
    oldChapterCount,
    mismatchWarning,
  }
}

/** Same parse-and-write path as a normal scan (applyIngestedCandidate),
 * just targeted at one book instead of the whole source — keeps the
 * book's id, so cloud-synced progress/bookmarks/downloads survive. */
export async function confirmRelink(
  source: SourceRow,
  book: BookRow,
  relativePath: string,
  format: 'm4b' | 'mp3_folder',
): Promise<{ bookId: string }> {
  const candidate = await buildCandidate(source, relativePath, format)
  const hash = await contentHash(candidate.hashInput)
  const { bookId } = await applyIngestedCandidate(source, candidate, book.id, hash)
  return { bookId }
}
