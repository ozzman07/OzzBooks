import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMobiFile, isOrphanedConversion, convertedEpubPath } from '../src/ingestion/mobiConvert.js'
import { convertedEbooksDir } from '../src/config.js'

describe('isMobiFile', () => {
  it('matches .mobi case-insensitively, not other extensions', () => {
    expect(isMobiFile('Book.mobi')).toBe(true)
    expect(isMobiFile('Book.MOBI')).toBe(true)
    expect(isMobiFile('Book.epub')).toBe(false)
    expect(isMobiFile('Book.azw3')).toBe(false)
  })
})

describe('isOrphanedConversion', () => {
  it('is true only for a missing book whose file lives under convertedEbooksDir', () => {
    expect(isOrphanedConversion({ status: 'missing', file_path: convertedEpubPath('some-book-id') })).toBe(true)
  })

  it('is false for an active book, even if converted', () => {
    expect(isOrphanedConversion({ status: 'active', file_path: convertedEpubPath('some-book-id') })).toBe(false)
  })

  it('is false for a missing book whose file is a real, non-converted path', () => {
    expect(isOrphanedConversion({ status: 'missing', file_path: '/volumes/books/ebooks/Author/Book.epub' })).toBe(false)
  })

  it('is false for a missing book under a folder that merely starts with the same prefix string', () => {
    // Guards against a naive startsWith(convertedEbooksDir) without the
    // trailing separator matching an unrelated sibling directory whose
    // name happens to share the same prefix.
    const lookalike = path.join(convertedEbooksDir + '-other', 'book.epub')
    expect(isOrphanedConversion({ status: 'missing', file_path: lookalike })).toBe(false)
  })
})
