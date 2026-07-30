import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-companion-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
}, 30_000)

async function insertSource(pathScope: string) {
  const { getDb } = await import('../src/db/index.js')
  const id = randomUUID()
  getDb()
    .prepare("INSERT INTO sources (id, type, label, path_scope) VALUES (?, 'local', 'Test Source', ?)")
    .run(id, pathScope)
  return id
}

async function insertBook(
  sourceId: string,
  filePath: string,
  format: 'm4b' | 'mp3_folder' | 'epub',
  title: string,
  author: string,
) {
  const { getDb } = await import('../src/db/index.js')
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO books (id, source_id, file_path, format, title, author, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
    )
    .run(id, sourceId, filePath, format, title, author)
  return id
}

describe('runCompanionLinking', () => {
  it('auto-links an audiobook and ebook that share a matching folder path across two sources', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { runCompanionLinking } = await import('../src/ingestion/companionLink.js')

    const audioSourceId = await insertSource('/nas/Audiobooks')
    const epubSourceId = await insertSource('/nas/Ebooks')
    const audioId = await insertBook(
      audioSourceId,
      '/nas/Audiobooks/Sanderson, Brandon/Mistborn 01 - The Final Empire.m4b',
      'm4b',
      'The Final Empire',
      'Brandon Sanderson',
    )
    const epubId = await insertBook(
      epubSourceId,
      '/nas/Ebooks/Sanderson, Brandon/Mistborn 01 - The Final Empire.epub',
      'epub',
      'The Final Empire',
      'Brandon Sanderson',
    )

    const result = runCompanionLinking()
    expect(result.linked).toBe(1)

    const audioBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(audioId) as any
    const epubBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(epubId) as any
    expect(audioBook.companion_book_id).toBe(epubId)
    expect(epubBook.companion_book_id).toBe(audioId)

    const log = getDb()
      .prepare("SELECT * FROM activity_log WHERE book_id = ? AND action = 'metadata_updated'")
      .get(audioId) as any
    expect(log.detail).toContain('Auto-linked')
  })

  it('links by title/author alone when folder conventions differ, as long as the match is unambiguous', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { runCompanionLinking } = await import('../src/ingestion/companionLink.js')

    const audioSourceId = await insertSource('/nas/Audiobooks2')
    const epubSourceId = await insertSource('/nas/Ebooks2')
    const audioId = await insertBook(
      audioSourceId,
      '/nas/Audiobooks2/messy_folder_name/book.m4b',
      'm4b',
      'The Way of Kings',
      'Brandon Sanderson',
    )
    const epubId = await insertBook(
      epubSourceId,
      '/nas/Ebooks2/unrelated_structure/file.epub',
      'epub',
      'The Way of Kings',
      'Brandon Sanderson',
    )

    const result = runCompanionLinking()
    expect(result.linked).toBe(1)
    const audioBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(audioId) as any
    expect(audioBook.companion_book_id).toBe(epubId)
  })

  it('does not link when no candidate is a confident, unambiguous match', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { runCompanionLinking } = await import('../src/ingestion/companionLink.js')

    const audioSourceId = await insertSource('/nas/Audiobooks3')
    const epubSourceId = await insertSource('/nas/Ebooks3')
    const audioId = await insertBook(
      audioSourceId,
      '/nas/Audiobooks3/Some Author/Completely Unrelated Title.m4b',
      'm4b',
      'Completely Unrelated Title',
      'Some Author',
    )
    const epubId = await insertBook(
      epubSourceId,
      '/nas/Ebooks3/Different Author/A Totally Different Book.epub',
      'epub',
      'A Totally Different Book',
      'Different Author',
    )

    const result = runCompanionLinking()
    expect(result.linked).toBe(0)
    const audioBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(audioId) as any
    const epubBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(epubId) as any
    expect(audioBook.companion_book_id).toBeNull()
    expect(epubBook.companion_book_id).toBeNull()
  })

  it('does not auto-link when two audiobooks are an equally good match for the same ebook (ambiguous)', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { runCompanionLinking } = await import('../src/ingestion/companionLink.js')

    const audioSourceId = await insertSource('/nas/Audiobooks4')
    const epubSourceId = await insertSource('/nas/Ebooks4')
    const audioId1 = await insertBook(
      audioSourceId,
      '/nas/Audiobooks4/Author X/Twin Title.m4b',
      'm4b',
      'Twin Title',
      'Author X',
    )
    const audioId2 = await insertBook(
      audioSourceId,
      '/nas/Audiobooks4/Author X/Twin Title (2).m4b',
      'm4b',
      'Twin Title',
      'Author X',
    )
    const epubId = await insertBook(epubSourceId, '/nas/Ebooks4/Author X/Twin Title.epub', 'epub', 'Twin Title', 'Author X')

    const result = runCompanionLinking()
    expect(result.linked).toBe(0)
    for (const id of [audioId1, audioId2, epubId]) {
      const book = getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as any
      expect(book.companion_book_id).toBeNull()
    }
  })

  it('skips books that are already linked', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { runCompanionLinking, linkCompanions } = await import('../src/ingestion/companionLink.js')

    const audioSourceId = await insertSource('/nas/Audiobooks5')
    const epubSourceId = await insertSource('/nas/Ebooks5')
    const audioId = await insertBook(
      audioSourceId,
      '/nas/Audiobooks5/Author Y/Book Y.m4b',
      'm4b',
      'Book Y',
      'Author Y',
    )
    const epubId1 = await insertBook(epubSourceId, '/nas/Ebooks5/Author Y/Book Y.epub', 'epub', 'Book Y', 'Author Y')
    const epubId2 = await insertBook(
      epubSourceId,
      '/nas/Ebooks5/Author Y/Book Y Alt Edition.epub',
      'epub',
      'Book Y',
      'Author Y',
    )

    linkCompanions(audioId, epubId1, 'Pre-linked for this test')
    const result = runCompanionLinking()
    expect(result.linked).toBe(0) // audioId already has a companion, epubId2 has nothing eligible to pair with

    const audioBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(audioId) as any
    expect(audioBook.companion_book_id).toBe(epubId1)
    const epub2 = getDb().prepare('SELECT * FROM books WHERE id = ?').get(epubId2) as any
    expect(epub2.companion_book_id).toBeNull()
  })
})

describe('unlinkCompanions', () => {
  it('clears the link on both sides and logs the removal', async () => {
    const { getDb } = await import('../src/db/index.js')
    const { linkCompanions, unlinkCompanions } = await import('../src/ingestion/companionLink.js')

    const audioSourceId = await insertSource('/nas/Audiobooks6')
    const epubSourceId = await insertSource('/nas/Ebooks6')
    const audioId = await insertBook(audioSourceId, '/nas/Audiobooks6/a.m4b', 'm4b', 'Book Z', 'Author Z')
    const epubId = await insertBook(epubSourceId, '/nas/Ebooks6/a.epub', 'epub', 'Book Z', 'Author Z')

    linkCompanions(audioId, epubId, 'Linked for this test')
    unlinkCompanions(audioId)

    const audioBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(audioId) as any
    const epubBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(epubId) as any
    expect(audioBook.companion_book_id).toBeNull()
    expect(epubBook.companion_book_id).toBeNull()

    const logs = getDb()
      .prepare("SELECT * FROM activity_log WHERE book_id IN (?, ?) AND detail = 'Companion link removed'")
      .all(audioId, epubId)
    expect(logs).toHaveLength(2)
  })
})
