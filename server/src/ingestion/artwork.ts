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
 * Resizes+saves thumbnail/full-size PNGs from a raw image Buffer,
 * whatever its source — an embedded tag picture, a local cover.jpg, or
 * (see ingestion/enrichment/) a cover downloaded from Open Library.
 * Factored out of extractArtwork() so all three sources share this
 * instead of duplicating the sharp resize/save calls. Returns null if
 * the image data is corrupt/truncated and sharp can't decode it (e.g. a
 * premature end of a JPEG) rather than throwing — same "degrade
 * gracefully, don't fail the whole book over a bad thumbnail" reasoning
 * as before.
 */
export async function saveArtworkBuffer(bookId: string, source: Buffer): Promise<ArtworkPaths | null> {
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

/**
 * Extracts cover art (embedded tag picture, else cover.jpg/folder.jpg in the
 * book's directory) and saves it via saveArtworkBuffer(). Returns null if
 * no art was found at all.
 */
export async function extractArtwork(
  bookId: string,
  bookDir: string,
  metadata: IAudioMetadata,
): Promise<ArtworkPaths | null> {
  const embedded = metadata.common.picture?.[0]
  const source = embedded ? Buffer.from(embedded.data) : await findFolderCover(bookDir)
  if (!source) return null
  return saveArtworkBuffer(bookId, source)
}
