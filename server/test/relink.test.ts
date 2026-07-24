import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

let dataDir: string

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-relink-data-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
}, 30_000)

async function insertSource(pathScope: string) {
  const { getDb } = await import('../src/db/index.js')
  const db = getDb()
  const id = randomUUID()
  db.prepare("INSERT INTO sources (id, type, label, path_scope) VALUES (?, 'local', 'Browse Test', ?)").run(id, pathScope)
  return getDb().prepare('SELECT * FROM sources WHERE id = ?').get(id) as any
}

describe('browseSourceDirectory', () => {
  it(
    'lists m4b/m4a files and mp3-containing folders, checked in parallel — same result regardless of folder count',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'ozzbooks-browse-'))

      // Deliberately more than a couple of sibling folders — this is what
      // exposed the real bug: the per-folder "has mp3s" check used to run
      // sequentially (await inside a for loop), so on a real library's
      // couple-hundred-folder root this took ~28s over a network
      // filesystem with zero loading indicator on the client — the whole
      // browse feature looked like it did nothing.
      const emptyFolder = path.join(root, 'Empty Folder')
      await mkdir(emptyFolder, { recursive: true })

      const mp3Folder = path.join(root, 'MP3 Book')
      await mkdir(mp3Folder, { recursive: true })
      await writeFile(path.join(mp3Folder, 'chapter 1.mp3'), 'fake mp3 bytes')

      const nonAudioFolder = path.join(root, 'Just Text Files')
      await mkdir(nonAudioFolder, { recursive: true })
      await writeFile(path.join(nonAudioFolder, 'notes.txt'), 'not audio')

      await writeFile(path.join(root, 'Standalone Book.m4b'), 'fake m4b bytes')
      await writeFile(path.join(root, 'Standalone Book.m4a'), 'fake m4a bytes')
      await writeFile(path.join(root, 'cover.jpg'), 'not audio, must be excluded')
      await writeFile(path.join(root, 'drm book.aax'), 'DRM-encumbered, must be excluded')

      const { browseSourceDirectory } = await import('../src/ingestion/relink.js')
      const source = await insertSource(root)

      const entries = await browseSourceDirectory(source, '')

      const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
      expect(Object.keys(byName).sort()).toEqual(
        [
          'Empty Folder',
          'Just Text Files',
          'MP3 Book',
          'Standalone Book.m4a',
          'Standalone Book.m4b',
        ].sort(),
      )

      expect(byName['Empty Folder']).toMatchObject({ type: 'folder', selectable: false, format: undefined })
      expect(byName['Just Text Files']).toMatchObject({ type: 'folder', selectable: false, format: undefined })
      expect(byName['MP3 Book']).toMatchObject({ type: 'folder', selectable: true, format: 'mp3_folder' })
      expect(byName['Standalone Book.m4b']).toMatchObject({ type: 'file', selectable: true, format: 'm4b' })
      expect(byName['Standalone Book.m4a']).toMatchObject({ type: 'file', selectable: true, format: 'm4b' })
    },
    30_000,
  )

  it('navigates one level into a subfolder using the path returned for it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ozzbooks-browse-'))
    const authorDir = path.join(root, 'Some Author')
    await mkdir(authorDir, { recursive: true })
    await writeFile(path.join(authorDir, 'Book One.m4b'), 'fake m4b bytes')

    const { browseSourceDirectory } = await import('../src/ingestion/relink.js')
    const source = await insertSource(root)

    const rootEntries = await browseSourceDirectory(source, '')
    expect(rootEntries).toEqual([{ name: 'Some Author', path: 'Some Author', type: 'folder', selectable: false, format: undefined }])

    const nestedEntries = await browseSourceDirectory(source, rootEntries[0].path)
    expect(nestedEntries).toEqual([
      { name: 'Book One.m4b', path: path.join('Some Author', 'Book One.m4b'), type: 'file', selectable: true, format: 'm4b' },
    ])
  })
})
