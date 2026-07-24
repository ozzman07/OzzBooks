import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, copyFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

// frequency varies per call so each test's file has genuinely distinct
// audio content (and therefore a distinct content_hash) — three tests
// generating byte-identical files would collide via the same-content
// cross-source duplicate check in scanSource, silently skipping ingestion
// for whichever runs later.
async function makeTone(outPath: string, frequency: number) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=1`,
    '-metadata',
    'title=Book One',
    '-metadata',
    'artist=Trash Test Author',
    '-c:a',
    'aac',
    outPath,
  ])
}

let dataDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-trash-data-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
}, 30_000)

async function insertSource(pathScope: string) {
  const { getDb } = await import('../src/db/index.js')
  const db = getDb()
  const id = randomUUID()
  db.prepare("INSERT INTO sources (id, type, label, path_scope) VALUES (?, 'local', 'Trash Test', ?)").run(id, pathScope)
  return getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id) as any
}

describe('removeTrashedBooks', () => {
  it(
    'deletes (not marks missing) a book whose file moved into a zzz folder, and cleans up its artwork',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'ozzbooks-trash-lib-'))
      const authorDir = path.join(root, 'Trash Test Author')
      await mkdir(authorDir, { recursive: true })
      const originalPath = path.join(authorDir, 'Book One.m4b')
      await makeTone(originalPath, 220)

      const { scanSource } = await import('../src/ingestion/scan.js')
      const { getDb } = await import('../src/db/index.js')
      const db = getDb()
      const source = await insertSource(root)

      await scanSource(source)
      const bookBefore = db.prepare('SELECT * FROM books WHERE source_id = ?').get(source.id) as any
      expect(bookBefore).toBeTruthy()
      expect(bookBefore.status).toBe('active')

      // Give it fake-but-real artwork files, so the delete's cleanup step
      // has something real to unlink and verify.
      const thumbPath = path.join(dataDir, `${bookBefore.id}-thumb.png`)
      const fullPath = path.join(dataDir, `${bookBefore.id}-full.png`)
      await writeFile(thumbPath, 'fake thumb bytes')
      await writeFile(fullPath, 'fake full bytes')
      db.prepare('UPDATE books SET artwork_thumb_path = ?, artwork_full_path = ? WHERE id = ?').run(
        thumbPath,
        fullPath,
        bookBefore.id,
      )

      // Simulate the user moving (and renaming) the file into a trash
      // folder — same audio bytes, different name/location, matching this
      // library's real "zzzSource files" cleanup convention.
      const trashDir = path.join(authorDir, 'zzzSource files')
      await mkdir(trashDir, { recursive: true })
      await copyFile(originalPath, path.join(trashDir, 'Book One (original copy).m4b'))
      await rm(originalPath)

      const result = await scanSource(source)
      expect(result.removedAsTrash).toBe(1)
      expect(result.markedMissing).toBe(0)

      const bookAfter = db.prepare('SELECT * FROM books WHERE id = ?').get(bookBefore.id)
      expect(bookAfter).toBeUndefined()

      await expect(access(thumbPath)).rejects.toThrow()
      await expect(access(fullPath)).rejects.toThrow()
    },
    30_000,
  )

  it(
    'leaves a genuinely missing book (no trash match anywhere) marked missing, same as before this feature',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'ozzbooks-trash-lib-'))
      const authorDir = path.join(root, 'Genuinely Gone Author')
      await mkdir(authorDir, { recursive: true })
      const filePath = path.join(authorDir, 'Book One.m4b')
      await makeTone(filePath, 330)

      const { scanSource } = await import('../src/ingestion/scan.js')
      const { getDb } = await import('../src/db/index.js')
      const db = getDb()
      const source = await insertSource(root)

      await scanSource(source)
      const bookBefore = db.prepare('SELECT * FROM books WHERE source_id = ?').get(source.id) as any

      await rm(filePath) // deleted outright — no trash copy anywhere

      const result = await scanSource(source)
      expect(result.markedMissing).toBe(1)
      expect(result.removedAsTrash).toBe(0)

      const bookAfter = db.prepare('SELECT * FROM books WHERE id = ?').get(bookBefore.id) as any
      expect(bookAfter.status).toBe('missing')
    },
    30_000,
  )

  it(
    'retroactively removes a book that was already missing from a past scan once a trash copy appears',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'ozzbooks-trash-lib-'))
      const authorDir = path.join(root, 'Retroactive Author')
      await mkdir(authorDir, { recursive: true })
      const filePath = path.join(authorDir, 'Book One.m4b')
      await makeTone(filePath, 440)
      // Keep the bytes around (outside the scanned tree — inside it, this
      // would itself be discovered as a same-hash candidate and hijack the
      // book via the auto-relink-by-hash logic, before the test even gets
      // to the "trash copy" part) so a later "trash copy" is a genuine
      // content match, not a freshly re-encoded (and therefore
      // different-hash) file.
      const holdingDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-trash-holding-'))
      const holdingCopy = path.join(holdingDir, 'holding-copy.m4b')
      await copyFile(filePath, holdingCopy)

      const { scanSource } = await import('../src/ingestion/scan.js')
      const { getDb } = await import('../src/db/index.js')
      const db = getDb()
      const source = await insertSource(root)

      await scanSource(source)
      const bookBefore = db.prepare('SELECT * FROM books WHERE source_id = ?').get(source.id) as any

      // The file disappears with no trash copy yet — today's existing
      // "mark missing" behavior, unaffected by this feature.
      await rm(filePath)
      const firstResult = await scanSource(source)
      expect(firstResult.markedMissing).toBe(1)
      expect((db.prepare('SELECT * FROM books WHERE id = ?').get(bookBefore.id) as any).status).toBe('missing')

      // Later, a trash copy shows up (e.g. the user finishes a cleanup
      // pass days later) — the next scan should retroactively catch this
      // even though the book wasn't newly-missing this time.
      const trashDir = path.join(authorDir, 'To Delete')
      await mkdir(trashDir, { recursive: true })
      await copyFile(holdingCopy, path.join(trashDir, 'Book One (dup).m4b'))

      const secondResult = await scanSource(source)
      expect(secondResult.removedAsTrash).toBe(1)
      const bookAfter = db.prepare('SELECT * FROM books WHERE id = ?').get(bookBefore.id)
      expect(bookAfter).toBeUndefined()
    },
    30_000,
  )
})
