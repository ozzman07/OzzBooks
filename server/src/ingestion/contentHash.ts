import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

const SAMPLE_BYTES = 64 * 1024

/**
 * The actual fingerprint math, factored out so a remote source (no local
 * file handle available) can produce a hash directly comparable to a
 * local one for the same underlying bytes — this is what makes
 * cross-source dedup (scanSource()'s content_hash query) work across
 * source types, not just within local sources.
 */
function hashFromSamples(size: number, head: Buffer, tail: Buffer): string {
  return createHash('sha256').update(String(size)).update(head).update(tail).digest('hex')
}

/**
 * Cheap fingerprint for duplicate-across-sources detection: full-file
 * hashing would be correct but far too slow for hundred-MB+ audiobooks, so
 * we hash file size plus the first/last chunk — enough to catch the real
 * case (same file present via two sources) without reading the whole file.
 */
export async function contentHash(filePath: string): Promise<string> {
  const { size } = await stat(filePath)
  const handle = await open(filePath, 'r')
  try {
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size))
    await handle.read(head, 0, head.length, 0)

    const tailSize = Math.min(SAMPLE_BYTES, size)
    const tail = Buffer.alloc(tailSize)
    await handle.read(tail, 0, tailSize, Math.max(0, size - tailSize))

    return hashFromSamples(size, head, tail)
  } finally {
    await handle.close()
  }
}

async function fetchRange(url: string, headers: Record<string, string>, start: number, end: number): Promise<Buffer> {
  const res = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } })
  if (!res.ok && res.status !== 206) {
    throw new Error(`Range request failed while hashing: ${res.status} ${res.statusText}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Same fingerprint as contentHash(), computed from a remote file via two
 * small Range GETs (head + tail) instead of a local file handle — the
 * bytes fetched here overlap with what the metadata-parsing tokenizer
 * already pulls for chapter/tag extraction, not new network cost on top
 * of that. `size` comes from the provider's own file listing (e.g.
 * Drive's file metadata), no separate lookup needed.
 */
export async function remoteContentHash(url: string, headers: Record<string, string>, size: number): Promise<string> {
  const sampleSize = Math.min(SAMPLE_BYTES, size)
  const [head, tail] = await Promise.all([
    fetchRange(url, headers, 0, sampleSize - 1),
    fetchRange(url, headers, Math.max(0, size - sampleSize), size - 1),
  ])
  return hashFromSamples(size, head, tail)
}
