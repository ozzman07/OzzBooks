import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import type { IAudioMetadata } from 'music-metadata'
import { artworkDir } from '../config.js'

const CANDIDATE_FILENAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.jpeg', 'folder.png']

export interface ArtworkPaths {
  thumbPath: string
  fullPath: string
}

async function findFolderCover(dir: string): Promise<Buffer | null> {
  const { readFile } = await import('node:fs/promises')
  for (const name of CANDIDATE_FILENAMES) {
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) {
      return readFile(candidate)
    }
  }
  return null
}

/**
 * Extracts cover art (embedded tag picture, else cover.jpg/folder.jpg in the
 * book's directory), writes thumbnail + full-size PNGs, and returns their
 * paths. Returns null if no art was found, or if the image data that was
 * found is corrupt/truncated and sharp can't decode it (e.g. a premature
 * end of a JPEG) — either way the frontend falls back to its own generic
 * placeholder, so a bad cover image degrades gracefully instead of failing
 * ingestion for the whole book (previously: a single corrupt cover image
 * threw out of this function uncaught, which the scan loop's per-candidate
 * catch treated the same as an unreadable audio file — the entire book got
 * skipped and marked as a scan failure over what's just a bad thumbnail).
 */
export async function extractArtwork(
  bookId: string,
  bookDir: string,
  metadata: IAudioMetadata,
): Promise<ArtworkPaths | null> {
  const embedded = metadata.common.picture?.[0]
  const source = embedded ? Buffer.from(embedded.data) : await findFolderCover(bookDir)
  if (!source) return null

  mkdirSync(artworkDir, { recursive: true })
  const thumbPath = path.join(artworkDir, `${bookId}-thumb.png`)
  const fullPath = path.join(artworkDir, `${bookId}-full.png`)

  try {
    await sharp(source).resize(200, 200, { fit: 'cover' }).png().toFile(thumbPath)
    await sharp(source).resize(1000, 1000, { fit: 'cover' }).png().toFile(fullPath)
  } catch (err) {
    console.warn(`Skipping corrupt cover art for book ${bookId}:`, err)
    return null
  }

  return { thumbPath, fullPath }
}
