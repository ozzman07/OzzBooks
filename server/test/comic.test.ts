import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  deriveComicSeriesFromSegments,
  detectArchiveKind,
  isCbrFile,
  isCbzFile,
  naturalCompare,
  readComicMetadata,
} from '../src/ingestion/comic.js'
import { makeTestComic } from './fixtures.js'

describe('isCbzFile / isCbrFile', () => {
  it('matches by extension, case-insensitively', () => {
    expect(isCbzFile('Batman - Hush.cbz')).toBe(true)
    expect(isCbzFile('Batman - Hush.CBZ')).toBe(true)
    expect(isCbzFile('Batman - Hush.cbr')).toBe(false)
    expect(isCbrFile('Batman - Hush.cbr')).toBe(true)
    expect(isCbrFile('Batman - Hush.CBR')).toBe(true)
    expect(isCbrFile('Batman - Hush.cbz')).toBe(false)
  })

  it('does not match unrelated extensions', () => {
    expect(isCbzFile('cover.jpg')).toBe(false)
    expect(isCbrFile('notes.txt')).toBe(false)
  })
})

describe('naturalCompare', () => {
  it('sorts digit runs numerically, not lexically', () => {
    expect(naturalCompare('page2.jpg', 'page10.jpg')).toBeLessThan(0)
    expect(naturalCompare('page10.jpg', 'page2.jpg')).toBeGreaterThan(0)
    expect(['page10.jpg', 'page2.jpg', 'page1.jpg'].sort(naturalCompare)).toEqual([
      'page1.jpg',
      'page2.jpg',
      'page10.jpg',
    ])
  })

  it('falls back to lexical comparison for non-numeric names', () => {
    expect(naturalCompare('cover.jpg', 'page1.jpg')).toBeLessThan(0)
    expect(naturalCompare('a.jpg', 'a.jpg')).toBe(0)
  })

  it('handles mixed-width numbers within the same name', () => {
    expect(['img_009.png', 'img_010.png', 'img_001.png'].sort(naturalCompare)).toEqual([
      'img_001.png',
      'img_009.png',
      'img_010.png',
    ])
  })
})

describe('deriveComicSeriesFromSegments', () => {
  it('takes the first segment as the series, regardless of nesting depth', () => {
    expect(deriveComicSeriesFromSegments(['Batman', 'some-gn.cbz'])).toBe('Batman')
    // The real "Batman - Hush" nested-folder case found on the NAS during
    // exploration — an extra nesting level must not fragment the series.
    expect(deriveComicSeriesFromSegments(['Batman', 'Batman - Hush', '02 The friend.cbr'])).toBe('Batman')
    expect(deriveComicSeriesFromSegments(['Batman', 'Elseworlds', 'some-gn.cbz'])).toBe('Batman')
  })

  it('returns null for a file sitting directly at the source root', () => {
    expect(deriveComicSeriesFromSegments(['loose.cbz'])).toBeNull()
  })
})

describe('detectArchiveKind', () => {
  async function writeBytes(bytes: number[]): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-magic-'))
    const filePath = path.join(dir, 'file.bin')
    await writeFile(filePath, Buffer.from(bytes))
    return filePath
  }

  it('classifies real zip magic bytes as zip', async () => {
    const filePath = await writeBytes([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    expect(await detectArchiveKind(filePath)).toBe('zip')
  })

  it('classifies real RAR magic bytes as rar', async () => {
    const filePath = await writeBytes([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0])
    expect(await detectArchiveKind(filePath)).toBe('rar')
  })

  it('classifies anything else as unknown', async () => {
    const filePath = await writeBytes([1, 2, 3, 4, 5, 6, 7, 8])
    expect(await detectArchiveKind(filePath)).toBe('unknown')
  })

  it('handles a file smaller than the magic-byte sample without throwing', async () => {
    const filePath = await writeBytes([0x50, 0x4b])
    expect(await detectArchiveKind(filePath)).toBe('unknown')
  })
})

describe('readComicMetadata', () => {
  it('parses every ComicInfo.xml field, decodes XML entities, and picks Number over Volume', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-'))
    const filePath = path.join(dir, 'test.cbz')
    await makeTestComic(filePath, {
      pages: ['page1.jpg', 'page2.jpg', 'page10.jpg'],
      comicInfo: {
        title: 'Hush &amp; Other Tales',
        series: 'Batman',
        number: 3,
        writer: 'Jeph Loeb',
        penciller: 'Jim Lee',
        publisher: 'DC Comics',
        year: 2003,
        pageCount: 32,
        summary: 'A tale of &lt;Gotham&gt;.',
      },
    })

    const meta = await readComicMetadata(filePath)
    expect(meta.title).toBe('Hush & Other Tales')
    expect(meta.seriesFromTag).toBe('Batman')
    expect(meta.issueNumberFromTag).toBe(3)
    expect(meta.writer).toBe('Jeph Loeb')
    expect(meta.penciller).toBe('Jim Lee')
    expect(meta.publisher).toBe('DC Comics')
    expect(meta.year).toBe(2003)
    expect(meta.pageCountFromTag).toBe(32)
    expect(meta.summary).toBe('A tale of <Gotham>.')

    // Authoritative pageCount/cover come from the archive's own natural-sorted
    // image entries, not the tag's PageCount claim.
    expect(meta.pageCount).toBe(3)
    expect(meta.coverBuffer?.toString()).toBe('page-content-page1.jpg')
  })

  it('falls back to <Volume> when <Number> is absent, and prefers <Number> when both are present', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-'))

    const volumeOnlyPath = path.join(dir, 'volume-only.cbz')
    const volumeOnlyZip = new JSZip()
    volumeOnlyZip.file('ComicInfo.xml', '<?xml version="1.0"?>\n<ComicInfo>\n  <Volume>7</Volume>\n</ComicInfo>')
    volumeOnlyZip.file('page1.jpg', Buffer.from('page-content-page1.jpg'))
    await writeFile(volumeOnlyPath, await volumeOnlyZip.generateAsync({ type: 'nodebuffer' }))

    const bothPath = path.join(dir, 'both.cbz')
    const bothZip = new JSZip()
    bothZip.file(
      'ComicInfo.xml',
      '<?xml version="1.0"?>\n<ComicInfo>\n  <Number>3</Number>\n  <Volume>7</Volume>\n</ComicInfo>',
    )
    bothZip.file('page1.jpg', Buffer.from('page-content-page1.jpg'))
    await writeFile(bothPath, await bothZip.generateAsync({ type: 'nodebuffer' }))

    expect((await readComicMetadata(volumeOnlyPath)).issueNumberFromTag).toBe(7)
    expect((await readComicMetadata(bothPath)).issueNumberFromTag).toBe(3)
  })

  it('returns all-null tag fields when no ComicInfo.xml is present', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-'))
    const filePath = path.join(dir, 'no-tag.cbz')
    await makeTestComic(filePath, { pages: ['a.jpg', 'b.jpg'], comicInfo: null })

    const meta = await readComicMetadata(filePath)
    expect(meta.title).toBeNull()
    expect(meta.seriesFromTag).toBeNull()
    expect(meta.issueNumberFromTag).toBeNull()
    expect(meta.writer).toBeNull()
    expect(meta.summary).toBeNull()
    // Image entries alone still produce a valid pageCount/cover.
    expect(meta.pageCount).toBe(2)
    expect(meta.coverBuffer?.toString()).toBe('page-content-a.jpg')
  })

  it('handles a zero-image archive without throwing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-comic-'))
    const filePath = path.join(dir, 'empty.cbz')
    await makeTestComic(filePath, { pages: [], comicInfo: { title: 'Empty' } })

    const meta = await readComicMetadata(filePath)
    expect(meta.pageCount).toBe(0)
    expect(meta.coverBuffer).toBeNull()
  })
})
