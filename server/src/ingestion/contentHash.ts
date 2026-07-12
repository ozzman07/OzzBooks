import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

const SAMPLE_BYTES = 64 * 1024

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

    return createHash('sha256').update(String(size)).update(head).update(tail).digest('hex')
  } finally {
    await handle.close()
  }
}
