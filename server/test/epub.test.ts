import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestEpub } from './fixtures.js'
import { readEpubMetadata } from '../src/ingestion/epub.js'

describe('readEpubMetadata', () => {
  it('reads title/author and the cover image from a real epub archive', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-epub-'))
    const filePath = path.join(dir, 'book.epub')
    await makeTestEpub(filePath, { title: 'The Test Book', author: 'Ada Lovelace' })

    const meta = await readEpubMetadata(filePath)
    expect(meta.title).toBe('The Test Book')
    expect(meta.author).toBe('Ada Lovelace')
    expect(meta.hasDrm).toBe(false)
    expect(meta.coverBuffer).not.toBeNull()
    expect(meta.coverBuffer!.length).toBeGreaterThan(0)
  })

  it('falls back to the filename when the epub has no title, and to null cover when none exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-epub-'))
    const filePath = path.join(dir, 'No Title Here.epub')
    await makeTestEpub(filePath, { title: '', author: 'Someone', includeCover: false })

    const meta = await readEpubMetadata(filePath)
    expect(meta.title).toBe('No Title Here')
    expect(meta.coverBuffer).toBeNull()
  })

  it('flags an epub whose actual content is encrypted as DRM', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-epub-'))
    const filePath = path.join(dir, 'drm.epub')
    await makeTestEpub(filePath, { title: 'DRM Book', author: 'Someone', includeDrm: true })

    const meta = await readEpubMetadata(filePath)
    expect(meta.hasDrm).toBe(true)
  })

  // Regression test: real-world epubs very commonly obfuscate embedded
  // fonts (a font-licensing requirement, done via the same META-INF/
  // encryption.xml mechanism as real DRM) while leaving the book's actual
  // text completely readable. The naive "does encryption.xml exist"
  // check false-positives on every one of these — this is what actually
  // showed up as "these say they have DRM but none of my books do" on a
  // real library, since font-obfuscated epubs are extremely common.
  it('does not flag an epub that only obfuscates an embedded font as DRM', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-epub-'))
    const filePath = path.join(dir, 'font-obfuscated.epub')
    await makeTestEpub(filePath, { title: 'Normal Book', author: 'Someone', includeFontObfuscation: true })

    const meta = await readEpubMetadata(filePath)
    expect(meta.hasDrm).toBe(false)
  })

  // A second real-world variant of the same false positive: some
  // conversion tools name the obfuscated font with a generic extension
  // (.dat) rather than preserving .ttf/.otf — extension-sniffing alone
  // misses this, so hasContentDrm also checks for a "fonts" folder.
  it('does not flag an epub whose obfuscated font uses a generic extension inside a fonts/ folder', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ozzbooks-epub-'))
    const filePath = path.join(dir, 'font-obfuscated-generic-ext.epub')
    await makeTestEpub(filePath, { title: 'Normal Book', author: 'Someone', includeFontObfuscationGenericExt: true })

    const meta = await readEpubMetadata(filePath)
    expect(meta.hasDrm).toBe(false)
  })
})
