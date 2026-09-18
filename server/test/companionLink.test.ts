import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-companion-'))
  process.env.OZZBOOKS_DATA_DIR = dataDir
}, 30_000)

async function insertSource(pathScope: string, type: 'local' | 'synology' | 'dropbox' | 'google_drive' = 'local') {
  const { getDb } = await import('../src/db/index.js')
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO sources (id, type, label, path_scope) VALUES (?, ?, ?, ?)')
    .run(id, type, 'Test Source', pathScope)
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

  it('links the correct sibling in a flat series folder instead of tying every book in it (real case: Piers Anthony "Bio of a Space Tyrant")', async () => {
    // Real bug found in production: when several books sit directly in one
    // shared series folder with no per-book subfolder, the folder-path
    // signal alone is identical for every sibling — "Mercenary" and
    // "Refugee" both live in ".../Anthony, Piers/Bio of a Space Tyrant/",
    // so pathScore couldn't tell them apart at all and every sibling tied
    // (510 of 730 real audiobook/ebook pairs in this library were blocked
    // this way). Including each file's own basename fixes it: only the
    // genuinely matching pair shares "mercenary" on top of the shared
    // folder words.
    const { getDb } = await import('../src/db/index.js')
    const { runCompanionLinking } = await import('../src/ingestion/companionLink.js')

    const audioSourceId = await insertSource('/nas/Audiobooks-flat')
    const epubSourceId = await insertSource('/nas/Ebooks-flat')
    const seriesAudioDir = '/nas/Audiobooks-flat/Anthony, Piers/Bio of a Space Tyrant'
    const seriesEpubDir = '/nas/Ebooks-flat/Anthony, Piers/Bio of a Space Tyrant'

    const mercenaryAudioId = await insertBook(
      audioSourceId,
      `${seriesAudioDir}/Bio of a Space Tyrant 2 - Mercenary.m4b`,
      'm4b',
      'Mercenary',
      'Anthony, Piers',
    )
    const refugeeEpubId = await insertBook(
      epubSourceId,
      `${seriesEpubDir}/Bio of a Space Tyrant 1 - Refugee - Piers Anthony.epub`,
      'epub',
      'Refugee',
      'Anthony, Piers',
    )
    const mercenaryEpubId = await insertBook(
      epubSourceId,
      `${seriesEpubDir}/Bio of a Space Tyrant 2 - Mercenary - Piers Anthony.epub`,
      'epub',
      'Mercenary',
      'Anthony, Piers',
    )

    const result = runCompanionLinking()
    expect(result.linked).toBe(1)

    const mercenaryAudio = getDb().prepare('SELECT * FROM books WHERE id = ?').get(mercenaryAudioId) as any
    expect(mercenaryAudio.companion_book_id).toBe(mercenaryEpubId) // not refugeeEpubId
    const refugeeEpub = getDb().prepare('SELECT * FROM books WHERE id = ?').get(refugeeEpubId) as any
    expect(refugeeEpub.companion_book_id).toBeNull() // correctly left unlinked, no audiobook counterpart inserted
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

  it('does NOT link two different books by the same prolific author on author-name overlap alone (real case: Robin Hobb)', async () => {
    // Real false match found in production: "Assassin's Fate" (The Fitz
    // and the Fool trilogy) and "Fool's Fate" (The Tawny Man trilogy) are
    // two entirely different Robin Hobb books — but "hobb" + "robin" +
    // one shared generic word ("the", now excluded as a stopword) used to
    // be enough to pass AUTO_LINK_MIN_SCORE with no real title-specific
    // overlap at all. Content overlap must now clear its own minimum
    // independent of how much the author's own name overlaps.
    const { getDb } = await import('../src/db/index.js')
    const { runCompanionLinking } = await import('../src/ingestion/companionLink.js')

    const audioSourceId = await insertSource('/nas/Audiobooks-hobb')
    const epubSourceId = await insertSource('/nas/Ebooks-hobb')
    const audioId = await insertBook(
      audioSourceId,
      "/nas/Audiobooks-hobb/Hobb, Robin/The Fitz and the Fool/Fitz and the Fool 3 - Assassin's Fate.m4b",
      'm4b',
      "Assassin's Fate",
      'Hobb, Robin',
    )
    const epubId = await insertBook(
      epubSourceId,
      "/nas/Ebooks-hobb/Hobb, Robin/The Tawny Man/The Tawny Man 03 - Fool's Fate.epub",
      'epub',
      'Fools Fate',
      'Hobb, Robin',
    )

    const result = runCompanionLinking()
    expect(result.linked).toBe(0)
    const audioBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(audioId) as any
    const epubBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(epubId) as any
    expect(audioBook.companion_book_id).toBeNull()
    expect(epubBook.companion_book_id).toBeNull()
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

  it('never auto-links an external-source (Google Drive) audiobook, even when it outscores a home-library candidate (real case: Cold Days)', async () => {
    // Real case: the ebook "Cold Days: A Novel of the Dresden Files" is a
    // NAS-scoped book. Two audiobook candidates exist — a NAS copy titled
    // plainly "Cold Days", and a Google Drive copy titled "The Dresden
    // Files 14.0 - Cold Days" whose more verbose filename happens to
    // repeat "Dresden Files" from the ebook's own subtitle, scoring
    // *higher* on title-word overlap than the NAS copy despite being the
    // wrong pick — an external source should never win an auto-link
    // regardless of score, per the user's explicit "Google Drive is an
    // external source, don't match it with NAS files" direction.
    const epubSourceId = await insertSource('/nas/Ebooks6', 'local')
    const nasAudioSourceId = await insertSource('/nas/Audiobooks6', 'synology')
    const gdriveAudioSourceId = await insertSource('gdrive-root', 'google_drive')

    const epubId = await insertBook(
      epubSourceId,
      '/nas/Ebooks6/Butcher, Jim/Cold Days.epub',
      'epub',
      'Cold Days: A Novel of the Dresden Files',
      'Jim Butcher',
    )
    const nasAudioId = await insertBook(
      nasAudioSourceId,
      '/nas/Audiobooks6/Butcher, Jim/The Dresden Files/Dresden Files 14 - Cold Days.m4b',
      'm4b',
      'Cold Days',
      'Jim Butcher',
    )
    const gdriveAudioId = await insertBook(
      gdriveAudioSourceId,
      'gdrive-root/Butcher, Jim/The Dresden Files 14.0 - Cold Days.m4b',
      'm4b',
      'The Dresden Files 14.0 - Cold Days',
      'Jim Butcher',
    )

    const { runCompanionLinking } = await import('../src/ingestion/companionLink.js')
    const { getDb } = await import('../src/db/index.js')
    const result = runCompanionLinking()
    expect(result.linked).toBe(1)

    const epub = getDb().prepare('SELECT * FROM books WHERE id = ?').get(epubId) as any
    expect(epub.companion_book_id).toBe(nasAudioId)
    const gdriveAudio = getDb().prepare('SELECT * FROM books WHERE id = ?').get(gdriveAudioId) as any
    expect(gdriveAudio.companion_book_id).toBeNull()
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

describe('deleteBookAndArtwork', () => {
  it('deletes a book that is still someone else\'s companion_book_id without throwing a FOREIGN KEY error', async () => {
    // Regression test for a real production crash: companion_book_id has
    // no ON DELETE clause, so deleting a book still referenced that way
    // (e.g. during the trash-cleanup pass of a full rescan) used to throw
    // `SqliteError: FOREIGN KEY constraint failed` and abort the whole
    // operation — see ozzbooks-scan-fk-constraint-crash memory.
    const { getDb } = await import('../src/db/index.js')
    const { linkCompanions } = await import('../src/ingestion/companionLink.js')
    const { deleteBookAndArtwork } = await import('../src/ingestion/scan.js')

    const audioSourceId = await insertSource('/nas/Audiobooks7')
    const epubSourceId = await insertSource('/nas/Ebooks7')
    const audioId = await insertBook(audioSourceId, '/nas/Audiobooks7/a.m4b', 'm4b', 'Book Y', 'Author Y')
    const epubId = await insertBook(epubSourceId, '/nas/Ebooks7/a.epub', 'epub', 'Book Y', 'Author Y')
    linkCompanions(audioId, epubId, 'Linked for this test')

    const audioBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(audioId) as any
    await expect(deleteBookAndArtwork(audioBook)).resolves.toBeUndefined()

    expect(getDb().prepare('SELECT * FROM books WHERE id = ?').get(audioId)).toBeUndefined()
    const epubBook = getDb().prepare('SELECT * FROM books WHERE id = ?').get(epubId) as any
    expect(epubBook.companion_book_id).toBeNull() // dangling reference cleared, not left pointing at a deleted row
  })
})
