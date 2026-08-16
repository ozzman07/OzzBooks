import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { convertedEbooksDir } from '../config.js'

const execFileAsync = promisify(execFile)

export function isMobiFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.mobi')
}

export function convertedEpubPath(bookId: string): string {
  return path.join(convertedEbooksDir, `${bookId}.epub`)
}

/**
 * A missing book whose file lives under convertedEbooksDir is a mobi that
 * was converted before the "epub always wins" dedup rule existed (see
 * findCandidates in scan.ts) — since only the converted path is ever
 * stored, never the original .mobi's own folder, there's no way for a
 * future scan to relink it: it's a permanent orphan, not a temporarily
 * missing file. Surfaced to the API (see books.ts) so the frontend can
 * exclude these from Needs Attention specifically — nothing the user
 * does there could ever bring one of these back.
 */
export function isOrphanedConversion(book: { status: string; file_path: string }): boolean {
  return book.status === 'missing' && book.file_path.startsWith(convertedEbooksDir + path.sep)
}

/**
 * Converts a .mobi file to .epub via Calibre's ebook-convert CLI, so the
 * rest of the pipeline (metadata parsing, the reader, offline caching,
 * companion linking) never needs to know mobi was ever involved — it just
 * sees another epub. Cached at a deterministic per-book path and skipped
 * if that file already exists: unlike artwork's cheap resize-on-every-scan,
 * a real Calibre conversion takes real seconds, and re-running it for
 * every already-converted book on every nightly rescan would make that job
 * scale badly with library size for no benefit (the source file, once
 * ingested, isn't expected to change in place).
 *
 * Calibre doesn't attempt to break real DRM — a DRM-encumbered mobi makes
 * ebook-convert exit non-zero, which surfaces here as a thrown error. The
 * caller (scan.ts's applyIngestedCandidate) doesn't need its own DRM check
 * the way the native-epub path does: conversion failure *is* the signal,
 * caught by the same per-candidate try/catch that already skips a
 * DRM-encumbered real epub without aborting the rest of the scan.
 */
export async function convertMobiToEpub(mobiPath: string, bookId: string): Promise<string> {
  const outPath = convertedEpubPath(bookId)
  if (existsSync(outPath)) return outPath

  mkdirSync(convertedEbooksDir, { recursive: true })
  try {
    await execFileAsync('ebook-convert', [mobiPath, outPath], { timeout: 120_000 })
  } catch (err) {
    throw new Error(`mobi conversion failed for ${mobiPath} (possibly DRM-encumbered): ${String(err)}`)
  }
  return outPath
}
