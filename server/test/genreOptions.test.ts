import { describe, expect, it } from 'vitest'
import { GENRE_OPTIONS, mapToControlledGenre } from '../src/ingestion/enrichment/genreOptions.js'

describe('mapToControlledGenre', () => {
  it('returns null for no subjects', () => {
    expect(mapToControlledGenre(null)).toBeNull()
    expect(mapToControlledGenre(undefined)).toBeNull()
    expect(mapToControlledGenre([])).toBeNull()
  })

  it('maps a clean single subject to its bucket', () => {
    expect(mapToControlledGenre(['Science fiction'])).toBe('Science Fiction')
    expect(mapToControlledGenre(['Fantasy'])).toBe('Fantasy')
    expect(mapToControlledGenre(['Historical Fiction'])).toBe('Historical Fiction')
  })

  it('scores across the whole subject list, not just the first entry', () => {
    // "Fiction" alone matches nothing; Fantasy gets two independent hits.
    expect(mapToControlledGenre(['Fantasy fiction', 'Magic', 'Fiction'])).toBe('Fantasy')
  })

  it('ignores Open Library namespaced tags entirely', () => {
    expect(mapToControlledGenre(['franchise:Red Rising', 'award:hugo_award=1963', 'series:Expeditionary Force'])).toBeNull()
  })

  it('returns null rather than guessing on ambiguous/unrelated subjects', () => {
    expect(mapToControlledGenre(['Xanth (Imaginary place)', 'Ship captains', 'Short stories'])).toBeNull()
  })

  it("doesn't double-count science fiction toward Science & Nature", () => {
    expect(mapToControlledGenre(['Fiction, science fiction, general'])).toBe('Science Fiction')
  })

  it('exposes exactly the 17 controlled options', () => {
    expect(GENRE_OPTIONS).toHaveLength(17)
    expect(new Set(GENRE_OPTIONS).size).toBe(GENRE_OPTIONS.length)
  })
})
