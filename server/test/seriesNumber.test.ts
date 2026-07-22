import { describe, expect, it } from 'vitest'
import { deriveSeriesNumberFromName } from '../src/ingestion/seriesNumber.js'

describe('deriveSeriesNumberFromName', () => {
  it('reads an explicit keyword marker', () => {
    expect(deriveSeriesNumberFromName('Codex Alera', 'Book 3 - Cursors Fury')).toBe(3)
    expect(deriveSeriesNumberFromName('Some Series', 'Vol. 12 - Title')).toBe(12)
    expect(deriveSeriesNumberFromName('Some Series', '#7 Title')).toBe(7)
  })

  it('reads a number immediately following the series name, wherever it appears', () => {
    expect(deriveSeriesNumberFromName('Enders Saga', 'Enders Saga 3 - Xenocide')).toBe(3)
    expect(deriveSeriesNumberFromName('The Dresden Files', 'The Dresden Files 01.0 - Storm Front')).toBe(1)
  })

  it('supports decimal series positions (novella numbering like "17.5")', () => {
    expect(deriveSeriesNumberFromName('The Dresden Files', 'The Dresden Files 17.5 - The Law')).toBe(17.5)
  })

  it('returns null for an unnumbered novella sitting alongside numbered entries', () => {
    expect(deriveSeriesNumberFromName('The Dresden Files', 'The Dresden Files - Brief Cases')).toBeNull()
  })

  it('falls back to a number after the first separator when the series name is not echoed at all', () => {
    // Real case confirmed this session: "Jack Reacher" is the series
    // folder, but the book's own folder never mentions it — only the
    // filename does ("Lee Child - Reacher 1 - Killing Floor").
    expect(deriveSeriesNumberFromName('Jack Reacher', 'Lee Child - 01 Killing Floor')).toBe(1)
    expect(deriveSeriesNumberFromName('Jack Reacher', 'Lee Child - Reacher 1 - Killing Floor')).toBe(1)
  })

  it('does NOT mistake a year for a series position', () => {
    // The documented false positive this whole design guards against —
    // neither "1997" nor "3001" is a plausible series position.
    expect(deriveSeriesNumberFromName('Odyssey Series', '1997 - 3001 The Final Odyssey')).toBeNull()
  })

  it('rejects an implausibly large number even with an explicit keyword', () => {
    expect(deriveSeriesNumberFromName('Some Series', 'Book 3001 - Title')).toBeNull()
  })

  it('returns null when nothing plausible is found anywhere', () => {
    expect(deriveSeriesNumberFromName('Some Series', 'A Standalone Title With No Number')).toBeNull()
  })
})
