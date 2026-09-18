import { describe, expect, it } from 'vitest'
import { isDurationLikeTag, isJunkNameTag, isPlaceholderTag } from '../src/ingestion/mp3Folder.js'

describe('isDurationLikeTag', () => {
  it('flags the real Judge Dredd "Wanted Dredd Or Alive" / "Death Trap" Album tag values', () => {
    // Real Album tag values found on these files: each one is that file's
    // own duration in MM.SS form, not a real album/book name.
    for (const value of ['18.50', '16.17', '12.44', '15.34', '24.52', '17.47', '19.48']) {
      expect(isDurationLikeTag(value)).toBe(true)
    }
  })

  it('does not flag a real album/book name, including ones that are purely numeric', () => {
    for (const value of ['Going Postal', '1984', '1635', 'The Dresden Files']) {
      expect(isDurationLikeTag(value)).toBe(false)
    }
  })

  it('does not flag a plain integer or a decimal with a different number of fraction digits', () => {
    expect(isDurationLikeTag('1984.5')).toBe(false) // 1 fraction digit, not 2
    expect(isDurationLikeTag('1984.123')).toBe(false) // 3 fraction digits, not 2
    expect(isDurationLikeTag('1984')).toBe(false) // no decimal point at all
  })

  it('treats null/undefined/blank as not duration-like', () => {
    expect(isDurationLikeTag(null)).toBe(false)
    expect(isDurationLikeTag(undefined)).toBe(false)
    expect(isDurationLikeTag('')).toBe(false)
    expect(isDurationLikeTag('   ')).toBe(false)
  })
})

describe('isJunkNameTag', () => {
  it('flags the real Judge Dredd Artist tag value (".")', () => {
    expect(isJunkNameTag('.')).toBe(true)
  })

  it('flags any punctuation-only value with no letters or digits', () => {
    expect(isJunkNameTag('-')).toBe(true)
    expect(isJunkNameTag('--')).toBe(true)
    expect(isJunkNameTag('...')).toBe(true)
  })

  it('does not flag a real name, including one containing punctuation', () => {
    expect(isJunkNameTag('Matt Dinniman')).toBe(false)
    expect(isJunkNameTag("O'Brien")).toBe(false)
  })

  it('treats null/undefined/blank as not junk (already handled as "no tag" upstream)', () => {
    expect(isJunkNameTag(null)).toBe(false)
    expect(isJunkNameTag(undefined)).toBe(false)
    expect(isJunkNameTag('')).toBe(false)
    expect(isJunkNameTag('   ')).toBe(false)
  })
})

describe('isPlaceholderTag', () => {
  it('flags the real "JLA: Exterminators" straggler track\'s Album and Artist tag values', () => {
    // Real tags found on one mistagged track sitting alongside 4 otherwise
    // correctly-tagged sibling discs: the classic CDDB/freedb-lookup-failed
    // placeholder an older ripping tool stamps in, rip timestamp and all,
    // instead of leaving the field blank.
    expect(isPlaceholderTag('Unknown Album (19/06/2008 20:11:26)')).toBe(true)
    expect(isPlaceholderTag('Unknown Artist')).toBe(true)
  })

  it('matches case-insensitively and regardless of the trailing timestamp', () => {
    expect(isPlaceholderTag('unknown album')).toBe(true)
    expect(isPlaceholderTag('UNKNOWN ARTIST')).toBe(true)
    expect(isPlaceholderTag('Unknown Album (01/01/1970 00:00:00)')).toBe(true)
  })

  it('flags the real Andre Norton epub <dc:creator> placeholder values ("Unknown" / "Unknown Author")', () => {
    // Real case: 6 epubs in this library have a bare "Unknown" or "Unknown
    // Author" <dc:creator> instead of a real name or an empty tag —
    // generalized to "unknown" plus at most one more word so this single
    // check covers both the mp3 ripper's and the epub converter's own
    // placeholder conventions.
    expect(isPlaceholderTag('Unknown')).toBe(true)
    expect(isPlaceholderTag('Unknown Author')).toBe(true)
  })

  it('does not flag a real album/artist name, including one that starts with "Unknown" as an actual title word', () => {
    expect(isPlaceholderTag('Going Postal')).toBe(false)
    expect(isPlaceholderTag('The Unknown Soldier')).toBe(false)
  })

  it('does not flag "unknown" followed by more than one extra word', () => {
    // Guards against over-broadening: a real (if odd) three-word name
    // shouldn't be swept up just because it happens to start with
    // "unknown" — only the bare "unknown [+ one word]" placeholder shape
    // is rejected.
    expect(isPlaceholderTag('Unknown Colonel Smith')).toBe(false)
  })

  it('treats null/undefined/blank as not a placeholder', () => {
    expect(isPlaceholderTag(null)).toBe(false)
    expect(isPlaceholderTag(undefined)).toBe(false)
    expect(isPlaceholderTag('')).toBe(false)
  })
})
